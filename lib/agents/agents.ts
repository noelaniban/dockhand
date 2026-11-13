// The three agents. Each one tries the model first and falls back to a scripted version, so the
// flow always completes; the step records which one ran. Guardrails are applied after either.
import {
  CAP, DIST, blockersOf, cap1, clampCounter, dayOf, eligibleCarriers, firstName, laneBenchmark, list,
  normalizeOrder, pickSlot, quoteFor, r10, rm, slotOk, truckFor, LANES, city
} from '../domain/rules';
import type { Deal, Email, Order, Plan, Source, ToolCall } from '../domain/types';
import { CARRIERS, SLOTS } from '../tools/data';
import { carriersCounter, carriersEligible, carriersQuotes, exec, openLoads, tmsBenchmark, tmsOpenLoads, wmsDockSlots, type ToolCtx } from '../tools/tools';
import { MODELS, modelEnabled, runAgent, writeText } from './llm';

export interface AgentResult<T> { data: T; source: Source; notes: string[] }

const failNote = (e: unknown) => 'Model call failed (' + ((e as Error).message || 'error').slice(0, 80) + '), so the scripted fallback ran.';

// ---------- Intake ----------

const ORDER_SCHEMA = {
  type: 'object' as const,
  properties: {
    customer: { type: 'string' }, contact: { type: 'string' },
    destination: { type: 'string', description: 'City, or "Unknown" if not stated' },
    pallets: { type: 'number', description: '0 if not stated' }, commodity: { type: 'string' },
    temp: { type: 'string', enum: ['ambient', 'chilled', 'frozen'] },
    equipment: { type: 'array', items: { type: 'string' } },
    deliverBy: { type: 'string', description: 'Short, e.g. "Thu 19 Nov, before 12:00", or "Not stated"' },
    budgetRm: { type: ['number', 'null'] },
    missing: { type: 'array', items: { type: 'string' }, description: 'Names of required facts the customer did not state' }
  },
  required: ['customer', 'contact', 'destination', 'pallets', 'commodity', 'temp', 'equipment', 'deliverBy', 'budgetRm', 'missing']
};

/** Regex reader used when no model is configured. Deliberately conservative. */
export function readEmailScripted(e: Email): Partial<Order> {
  const b = e.body, p = b.match(/(\d+)\s*pallets?/i), bud = b.match(/RM\s?([\d,]+)/i);
  const frozen = /frozen|-\s?\d+\s*°c/i.test(b), chilled = !frozen && /chill|reefer|°c|cold/i.test(b);
  const dm = b.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(\d{1,2})\s*nov/i);
  // Signature: the last paragraph, minus the sign-off, as "Name" then "Company".
  const sig = (b.trim().split(/\n\s*\n/).pop() ?? '').split('\n').map(l => l.trim())
    .filter(l => l && !/^(thanks|thank you|regards|best|cheers|terima kasih)\b/i.test(l));
  const signed = sig.length > 0 && sig.length <= 2 && sig.every(l => l.length <= 40 && !/[.?!]$/.test(l));
  return {
    customer: e.test ? (signed && sig[1]) || e.company : e.company, contact: e.test ? (signed ? sig[0] : '') : e.from, destination: city(b) || 'Unknown', pallets: p ? Number(p[1]) : 0,
    commodity: frozen ? 'Frozen goods' : chilled ? 'Chilled goods' : 'General cargo', temp: frozen ? 'frozen' : chilled ? 'chilled' : 'ambient',
    equipment: [...(frozen || chilled ? ['Reefer'] : []), ...(/tail.?lift/i.test(b) ? ['Tail-lift'] : [])],
    deliverBy: dm ? cap1(dm[1].toLowerCase()) + ' ' + dm[2] + ' Nov' : 'Not stated',
    budgetRm: bud ? Number(bud[1].replace(/,/g, '')) : null, missing: []
  };
}

export async function intakeAgent(e: Email, ctx: ToolCtx): Promise<AgentResult<Order>> {
  exec({ def: { name: 'mail_read', description: '', input_schema: { type: 'object' } }, run: () => '1 message' }, { id: e.id }, ctx);
  const notes: string[] = [];
  let raw: Partial<Order> | null = null, source: Source = 'scripted';
  if (modelEnabled()) {
    try {
      raw = await runAgent<Partial<Order>>({
        model: MODELS.fast, ctx, tools: [],
        system: 'You are the intake agent of a warehouse control tower at Shah Alam DC, Malaysia. Today is Thursday 12 Nov 2026. Extract a transport order from the customer email. Served lanes: ' + LANES.join(', ') + '. Never guess a value that is not stated: put its name in "missing" and use 0, "Unknown" or "Not stated". Emails may mix English and Malay.',
        prompt: 'From: ' + (e.test ? 'unknown sender' : e.from + ', ' + e.company) + '\n\n' + e.body,
        final: { name: 'submit_order', description: 'Submit the extracted order.', input_schema: ORDER_SCHEMA }
      });
      source = 'model';
    } catch (err) { notes.push(failNote(err)); }
  }
  const order = normalizeOrder(raw ?? readEmailScripted(e), e.company);
  ctx.calls.push({ tool: 'submit_order', input: order, output: order.missing.length ? order.missing.length + ' field(s) missing' : 'all required fields found' });
  return { data: order, source, notes };
}

// ---------- Dispatch ----------

interface PlanDraft { decision: 'consolidate' | 'new_load'; load_id?: string | null; slot_index: number; rationale: string }

export async function dispatchAgent(o: Order, ctx: ToolCtx, nextLoadId: () => string): Promise<AgentResult<Plan>> {
  const notes: string[] = [];
  const fits = (id?: string | null) => openLoads(ctx, o.destination).find(l => l.id === id && l.temp === o.temp && l.pallets + o.pallets <= CAP);
  let draft: PlanDraft | null = null, source: Source = 'scripted';
  if (modelEnabled()) {
    try {
      draft = await runAgent<PlanDraft>({
        model: MODELS.smart, ctx, tools: [tmsOpenLoads, wmsDockSlots],
        system: 'You are the dispatch agent of a warehouse control tower at Shah Alam DC, Malaysia. Decide whether to consolidate the order into an open load or open a new one, and pick a dock slot. A truck holds ' + CAP + ' pallets. Consolidate only when destination and temperature match and the total fits. Pick the latest slot that still meets the delivery deadline with margin. Use the tools, then submit the plan. Keep the rationale to two sentences.',
        prompt: 'Order: ' + JSON.stringify(o),
        final: {
          name: 'submit_plan', description: 'Submit the load plan.',
          input_schema: { type: 'object', properties: { decision: { type: 'string', enum: ['consolidate', 'new_load'] }, load_id: { type: ['string', 'null'] }, slot_index: { type: 'number' }, rationale: { type: 'string' } }, required: ['decision', 'slot_index', 'rationale'] }
        }
      });
      source = 'model';
    } catch (err) { notes.push(failNote(err)); }
  }
  if (!draft) {
    exec(tmsOpenLoads, { destination: o.destination }, ctx);
    exec(wmsDockSlots, {}, ctx);
    const m = openLoads(ctx, o.destination).find(l => l.temp === o.temp && l.pallets + o.pallets <= CAP);
    draft = { decision: m ? 'consolidate' : 'new_load', load_id: m?.id ?? null, slot_index: pickSlot(SLOTS, o.deliverBy),
      rationale: m ? m.id + ' is already going to ' + o.destination + ' with ' + m.pallets + ' pallets, so this order fits on the same truck.' : 'No open load goes to ' + o.destination + ' at this temperature, so the order gets its own truck.' };
  }
  // Guardrails: never overbook a truck, never pick a slot that misses the deadline.
  const match = draft.decision === 'consolidate' ? fits(draft.load_id) : undefined;
  let why = String(draft.rationale || '').trim();
  if (draft.decision === 'consolidate' && !match) {
    why = 'The agent suggested ' + (draft.load_id || 'an open load') + ', but it does not fit on capacity or temperature, so the order gets its own truck.';
    notes.push('Guardrail: consolidation rejected, capacity or temperature did not fit.');
  }
  let si = Math.max(0, Math.min(SLOTS.length - 1, Math.round(Number(draft.slot_index)) || 0));
  if (!slotOk(SLOTS[si], o.deliverBy)) {
    si = pickSlot(SLOTS, o.deliverBy);
    const ok = slotOk(SLOTS[si], o.deliverBy);
    why += ok ? ' Pickup moved to ' + SLOTS[si].window + ' to meet the deadline.' : ' No free dock slot meets the deadline, so this is the earliest one.';
    notes.push('Guardrail: dock slot changed to meet the deadline.');
  } else if (source === 'scripted') {
    why += dayOf(o.deliverBy) ? ' Pickup ' + SLOTS[si].window + ' is the latest slot that still meets the deadline.' : ' No deadline was given, so it takes the next free slot.';
  }
  if (match) ctx.reserved[match.id] = ctx.requestId;
  const onTruck = match ? match.pallets : 0, total = o.pallets + onTruck, slot = SLOTS[si];
  return { data: { consolidate: !!match, loadId: match ? match.id : nextLoadId(), onTruck, total, truck: truckFor(o.temp, total), dock: slot.dock, window: slot.window, rationale: why }, source, notes };
}

// ---------- Carrier ----------

interface DealDraft { carrier: string; counter_rm: number; reason: string; message: string }

export async function carrierAgent(o: Order, p: Plan, ctx: ToolCtx): Promise<AgentResult<Deal>> {
  const notes: string[] = [];
  const { eligible, excluded } = eligibleCarriers(CARRIERS, o.temp, o.equipment);
  const quotes = eligible.map(c => quoteFor(c, o.destination, o.temp, p.total));
  const bench = laneBenchmark(o.destination, o.temp, p.total);
  let draft: DealDraft | null = null, source: Source = 'scripted';
  if (modelEnabled()) {
    try {
      draft = await runAgent<DealDraft>({
        model: MODELS.smart, ctx, tools: [carriersEligible, carriersQuotes, tmsBenchmark],
        system: 'You are the carrier agent of a warehouse control tower at Shah Alam DC, Malaysia. Find eligible carriers, get quotes, check the lane benchmark, and choose one carrier, weighing cost against on-time performance. Propose a counter-offer between 88% and 97% of the chosen quote, and write a 2 to 3 sentence message to the carrier signed "Dockhand, for Shah Alam DC". Keep the reason to two sentences.',
        prompt: 'Load: ' + JSON.stringify({ load_id: p.loadId, destination: o.destination, temp: o.temp, pallets_on_truck: p.total, truck: p.truck, pickup: p.window, required_equipment: o.equipment }),
        final: {
          name: 'submit_deal', description: 'Submit the chosen carrier, counter-offer and message.',
          input_schema: { type: 'object', properties: { carrier: { type: 'string' }, counter_rm: { type: 'number' }, reason: { type: 'string' }, message: { type: 'string' } }, required: ['carrier', 'counter_rm', 'reason', 'message'] }
        }
      });
      source = 'model';
    } catch (err) { notes.push(failNote(err)); }
  }
  if (!quotes.length) throw new Error('No permitted carrier has the equipment this load needs (' + (o.equipment.join(', ') || cap1(o.temp)) + ').');
  let q = draft ? quotes.find(x => x.carrier === draft!.carrier) : undefined;
  if (draft && !q) notes.push('Guardrail: ' + draft.carrier + ' is not an eligible carrier, so the scripted pick was used.');
  let deal: DealDraft;
  if (draft && q) deal = draft;
  else {
    if (source === 'scripted') { exec(carriersEligible, { temp: o.temp, equipment: o.equipment }, ctx); exec(carriersQuotes, { carriers: eligible.map(c => c.name), destination: o.destination, temp: o.temp, pallets_on_truck: p.total, equipment: o.equipment }, ctx); exec(tmsBenchmark, { destination: o.destination, temp: o.temp, pallets_on_truck: p.total }, ctx); }
    q = quotes.filter(x => x.onTimePct >= 93).sort((a, b) => a.quoteRm - b.quoteRm)[0] ?? quotes[0];
    const c0 = r10(q.quoteRm * 0.93);
    deal = { carrier: q.carrier, counter_rm: c0, reason: 'Lowest quote among carriers that run on time at least 93% of the time.',
      message: 'Hello, we have ' + p.total + ' pallets to ' + o.destination + ', pickup ' + p.window + '. Your quote is ' + rm(q.quoteRm) + '. We can confirm today at ' + rm(c0) + '.\n\nDockhand, for Shah Alam DC' };
  }
  const counter = clampCounter(q.quoteRm, deal.counter_rm);
  if (counter !== r10(deal.counter_rm)) notes.push('Guardrail: counter-offer kept between 88% and 100% of the quote.');
  const res = exec(carriersCounter, { carrier: q.carrier, quote_rm: q.quoteRm, counter_rm: counter, pickup: p.window }, ctx) as { agreed_rm: number; reply: string };
  return {
    data: { quotes, excluded: excluded.map(c => c.name + ' (APAD permit ' + c.permit.toLowerCase() + ')'), pick: q.carrier, quoteRm: q.quoteRm, counterRm: counter, finalRm: res.agreed_rm,
      benchmarkRm: bench, withinBenchmark: res.agreed_rm <= bench, reason: deal.reason, message: deal.message, reply: res.reply },
    source, notes
  };
}

// ---------- Confirmation ----------

export async function writeConfirmation(o: Order, p: Plan, d: Deal): Promise<{ text: string; source: Source }> {
  if (modelEnabled()) {
    try {
      const text = await writeText(MODELS.fast, 'You write short booking confirmations for a warehouse at Shah Alam DC. Plain text, 3 to 4 sentences, no subject line, no markdown. Do not mention the carrier rate. Sign off as "Shah Alam DC dispatch".',
        JSON.stringify({ contact: o.contact, customer: o.customer, pallets: o.pallets, commodity: o.commodity, destination: o.destination, pickup: p.window, deliver_by: o.deliverBy, carrier: d.pick, reference: p.loadId, still_needed_from_customer: o.missing }));
      if (text) return { text, source: 'model' };
    } catch { /* fall through to the template */ }
  }
  const text = 'Hi ' + (firstName(o.contact) || 'there') + ',\n\nYour ' + o.pallets + ' pallets to ' + o.destination + ' are booked under ' + p.loadId + ' with ' + d.pick + '. Pickup is ' + p.window
    + (/not stated/i.test(o.deliverBy) ? '.' : ', for delivery by ' + o.deliverBy + '.') + (o.missing.length ? ' Please send us the ' + list(o.missing.map(m => m.toLowerCase())) + '.' : '') + '\n\nShah Alam DC dispatch';
  return { text, source: 'scripted' };
}

export function clarificationFor(o: Order): string {
  return 'Hi ' + (firstName(o.contact) || 'there') + ',\n\nThanks for your request. Before we can book a truck, could you tell us the ' + list(o.missing.map(m => m.toLowerCase())) + '?\n\nShah Alam DC dispatch';
}

export { blockersOf, DIST };
export type { ToolCall };
