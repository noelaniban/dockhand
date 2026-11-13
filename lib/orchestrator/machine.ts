// The request state machine. Each request moves intake -> dispatch -> carrier -> booking and
// pauses at a gate after every agent. In auto mode a gate opens by itself only inside the limits:
// no missing fields, and never above the lane benchmark.
import { carrierAgent, clarificationFor, dispatchAgent, intakeAgent, writeConfirmation } from '../agents/agents';
import { blockersOf, list, rm } from '../domain/rules';
import type { Autonomy, Email, Run, StepKey, StepStatus } from '../domain/types';
import type { ToolCtx } from '../tools/tools';
import { clock, db, log } from './store';

export function stageOf(run?: Run): { key: StepKey; status: StepStatus } {
  if (!run?.intake) return { key: 'intake', status: 'running' };
  for (const k of ['booking', 'carrier', 'dispatch'] as const) { const s = run[k]; if (s) return { key: k, status: s.status }; }
  return { key: 'intake', status: run.intake.status };
}

export type RequestState = 'Needs you' | 'Agents working' | 'Waiting on the customer' | 'Booked';
export function requestState(run?: Run): RequestState {
  const g = stageOf(run);
  if (g.key === 'booking') return g.status === 'done' ? 'Booked' : 'Agents working';
  if (g.status === 'review') return 'Needs you';
  if (g.status === 'blocked') return 'Waiting on the customer';
  return 'Agents working';
}

const ctxFor = (id: string): ToolCtx => ({ requestId: id, loads: db().loads, reserved: db().reserved, calls: [] });
const auto = () => db().autonomy === 'auto';

async function intake(id: string, email: Email) {
  const s = db(), run = (s.runs[id] = s.runs[id] ?? {});
  run.intake = { status: 'running', calls: [], notes: [] };
  const ctx = ctxFor(id);
  const r = await intakeAgent(email, ctx);
  const go = auto() && !r.data.missing.length;
  run.intake = { status: go ? 'approved' : 'review', data: r.data, source: r.source, calls: ctx.calls, notes: r.notes, ...(go ? { by: 'agent' as const, at: clock() } : {}) };
  log('Intake', 'Read ' + r.data.customer + ': ' + (r.data.pallets ? r.data.pallets + ' pallets' : 'no pallet count') + ' to ' + r.data.destination + '.' + (r.data.missing.length ? ' Missing ' + list(r.data.missing.map(m => m.toLowerCase())) + '.' : ''));
  if (go) await dispatch(id);
}

async function dispatch(id: string) {
  const s = db(), run = s.runs[id], o = run.intake!.data!;
  run.dispatch = { status: 'running', calls: [], notes: [] };
  const ctx = ctxFor(id);
  const r = await dispatchAgent(o, ctx, () => 'LD-' + s.seq++);
  const go = auto();
  run.dispatch = { status: go ? 'approved' : 'review', data: r.data, source: r.source, calls: ctx.calls, notes: r.notes, ...(go ? { by: 'agent' as const, at: clock() } : {}) };
  log('Dispatch', (r.data.consolidate ? 'Added the order to ' : 'Planned new load ') + r.data.loadId + ', ' + r.data.total + ' pallets, ' + r.data.dock + '.');
  if (go) await carrier(id);
}

async function carrier(id: string) {
  const s = db(), run = s.runs[id], o = run.intake!.data!, p = run.dispatch!.data!;
  run.carrier = { status: 'running', calls: [], notes: [] };
  const ctx = ctxFor(id);
  const r = await carrierAgent(o, p, ctx);
  const go = auto() && r.data.withinBenchmark;
  run.carrier = { status: go ? 'approved' : 'review', data: r.data, source: r.source, calls: ctx.calls, notes: r.notes, ...(go ? { by: 'agent' as const, at: clock() } : {}) };
  log('Carrier', 'Negotiated ' + r.data.pick + ' from ' + rm(r.data.quoteRm) + ' to ' + rm(r.data.finalRm) + ' for ' + p.loadId + (r.data.withinBenchmark ? '.' : '. Above the lane benchmark, held.'));
  if (go) await book(id);
}

async function book(id: string) {
  const s = db(), run = s.runs[id], o = run.intake!.data!, p = run.dispatch!.data!, d = run.carrier!.data!;
  run.booking = { status: 'running', calls: [], notes: [] };
  const load = { id: p.loadId, dest: o.destination, pallets: p.total, temp: o.temp, pickup: p.window + ' · ' + p.dock, carrier: d.pick, rateRm: d.finalRm, status: 'Booked' as const };
  s.loads = p.consolidate ? s.loads.map(l => (l.id === p.loadId ? load : l)) : [...s.loads, load];
  delete s.reserved[p.loadId];
  s.bookedIn[id] = Date.now() - (s.arrivedAt[id] ?? Date.now());
  log('Carrier', 'Booked ' + p.loadId + ' with ' + d.pick + ' at ' + rm(d.finalRm) + '.');
  const c = await writeConfirmation(o, p, d);
  run.booking = { status: 'done', data: { loadId: p.loadId, confirmation: c.text }, source: c.source, calls: [{ tool: 'mail_draft', input: { to: o.contact }, output: 'drafted' }], notes: [] };
}

async function guarded(id: string, fn: () => Promise<void>) {
  const s = db();
  if (s.busy[id]) throw new Error('This request is already being worked on.');
  s.busy[id] = true;
  try { await fn(); } finally { s.busy[id] = false; }
}

/** Opens the gate the request is waiting at, then lets the next agent run. */
export async function approve(id: string) {
  await guarded(id, async () => {
    const run = db().runs[id];
    const g = stageOf(run);
    if (!run || g.status !== 'review') throw new Error('Nothing is waiting for approval on this request.');
    if (g.key === 'intake' && blockersOf(run.intake!.data!).length) throw new Error('This order cannot be planned yet. Ask the customer first.');
    const step = run[g.key]!;
    step.status = 'approved'; step.by = 'you'; step.at = clock();
    if (g.key === 'intake') {
      log('You', 'Confirmed the ' + run.intake!.data!.customer + ' order.'); await dispatch(id);
    } else if (g.key === 'dispatch') { log('You', 'Approved the plan for ' + run.dispatch!.data!.loadId + '.'); await carrier(id); }
    else if (g.key === 'carrier') { const d = run.carrier!.data!; log('You', 'Approved ' + d.pick + ' at ' + rm(d.finalRm) + '.'); await book(id); }
  });
}

/** For orders that cannot be planned: draft a clarification instead of guessing. */
export function askCustomer(id: string) {
  const run = db().runs[id];
  const o = run?.intake?.data;
  if (!run || !o || run.intake!.status !== 'review') throw new Error('Nothing to ask about on this request.');
  run.reply = clarificationFor(o);
  run.intake!.status = 'blocked'; run.intake!.by = 'you'; run.intake!.at = clock();
  log('You', 'Asked ' + o.customer + ' for the ' + list(o.missing.map(m => m.toLowerCase())) + '.');
}

export async function receive(body: string): Promise<string> {
  const s = db();
  const id = 'e' + ++s.mailN;
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const first = lines.find(l => l.length > 30 || !/^(hi|hello|hey|dear|morning|good)\b/i.test(l)) ?? lines[0] ?? 'New request';
  const email: Email = { id, test: true, from: 'Unknown sender', company: 'Test request', subject: first.length > 56 ? first.slice(0, 55) + '…' : first, receivedAt: clock(), body };
  s.emails.push(email);
  s.arrivedAt[id] = Date.now();
  await guarded(id, () => intake(id, email));
  return id;
}

export function setAutonomy(a: Autonomy) {
  const s = db();
  if (s.autonomy === a) return;
  s.autonomy = a;
  log('You', a === 'auto' ? 'Let agents run on their own within limits.' : 'Set agents to wait for approval at every step.');
}
