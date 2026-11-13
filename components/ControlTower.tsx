'use client';

import { useMemo, useState } from 'react';
import { CAP, DIST, blockersOf, cap1, firstName, list, rm } from '@/lib/domain/rules';
import type { Run } from '@/lib/domain/types';
import type { Snapshot } from '@/lib/orchestrator/snapshot';

type Req = Snapshot['requests'][number];
type View = 'requests' | 'loads' | 'carriers' | 'activity';

const GROUPS: [Req['state'], string][] = [
  ['Needs you', '#b45309'], ['Agents working', '#1d4fb8'], ['Waiting on the customer', '#8f8a84'], ['Booked', '#15803d']
];
const STEP_LABELS = ['Order', 'Load plan', 'Carrier', 'Booked'];
const AGENT_NAME = { intake: 'Intake agent', dispatch: 'Dispatch agent', carrier: 'Carrier agent' } as const;
const clock = (ms: number) => { const t = Math.max(1, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

function stage(run: Run) {
  if (!run.intake) return { key: 'intake' as const, status: 'running' as const };
  for (const k of ['booking', 'carrier', 'dispatch'] as const) { const s = run[k]; if (s) return { key: k, status: s.status }; }
  return { key: 'intake' as const, status: run.intake.status };
}

const Truck = ({ color = '#fff', size = 18 }: { color?: string; size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
);
const Chip = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
  </svg>
);

const NAV_ICON: Record<View, React.ReactNode> = {
  requests: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z" /></>,
  loads: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
  carriers: <><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></>,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
};
const NavIcon = ({ v }: { v: View }) => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{NAV_ICON[v]}</svg>
);

export default function ControlTower({ initial }: { initial: Snapshot }) {
  const [snap, setSnap] = useState(initial);
  const [view, setView] = useState<View>('requests');
  const [selId, setSelId] = useState<string | null>(initial.requests.find(r => r.state === 'Needs you')?.email.id ?? null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));

  async function post(url: string, body?: unknown, busyId?: string) {
    setError(null);
    if (busyId) setPending(busyId);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      const json = await res.json();
      if (json.snapshot) setSnap(json.snapshot);
      if (!json.ok) setError(json.error);
      return json;
    } catch {
      setError('Could not reach the server. Is it still running?');
    } finally {
      setPending(null);
    }
  }

  const needs = snap.requests.filter(r => r.state === 'Needs you').length;
  const sel = composing ? null : snap.requests.find(r => r.email.id === selId) ?? null;
  const next = snap.requests.find(r => r.email.id !== selId && r.state === 'Needs you');
  const auto = snap.autonomy === 'auto';
  // On narrow screens the card sits under the list, so bring it into view.
  const reveal = () => { if (window.innerWidth <= 920) requestAnimationFrame(() => document.querySelector('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })); };
  const select = (id: string) => { setView('requests'); setComposing(false); setSelId(id); setError(null); reveal(); };

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand">
            <span className="brand-mark"><Truck /></span>
            <span className="brand-name">Dockhand</span>
          </div>
          <nav className="nav" aria-label="Main">
            {(['requests', 'loads', 'carriers', 'activity'] as View[]).map(v => (
              <button key={v} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
                <NavIcon v={v} />{cap1(v)}{v === 'requests' && needs > 0 && <span className="badge">{needs}</span>}
              </button>
            ))}
          </nav>
          <div className="top-right">
            {/* Custom tooltip: shows instantly on hover or keyboard focus (native title waits ~1s). */}
            <div className="tip-wrap">
              <button className="switch" role="switch" aria-checked={auto} aria-describedby="autorun-tip" onClick={() => post('/api/settings', { autonomy: auto ? 'approve' : 'auto' })}>
                <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>Auto-run
              </button>
              <span id="autorun-tip" role="tooltip" className="tip">
                <b>{auto ? 'Auto-run is on' : 'Auto-run is off'}</b>
                {auto ? 'Agents act alone within limits. Missing fields and rates above benchmark still wait for you.' : 'Agents stop for your approval at every step. Turn on to let them act alone within limits.'}
              </span>
            </div>
            <span className="top-divider" aria-hidden="true" />
            {/* Who is signed in, which site they run, and whether agents are live. One chip, one place to look. */}
            <div className="user" title={'Signed in to Shah Alam DC. WMS, TMS and carrier tools are mocked; carrier replies are simulated.' + (snap.mode === 'model' ? ' Agents: ' + snap.models.fast + ' and ' + snap.models.smart + '.' : ' Add ANTHROPIC_API_KEY to use Claude.')}>
              <span className="user-avatar" aria-hidden="true">SA</span>
              <span className="user-text">
                <span className="user-name">Shah Alam DC</span>
                <span className="user-status">
                  <span className="dot" style={{ background: snap.mode === 'model' ? '#15803d' : '#a8a29e' }} />
                  {snap.mode === 'model' ? 'Live model' : 'Scripted agents'}
                </span>
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="page">
        {view === 'requests' && (
          <div className="split">
            <aside className="rail" aria-label="Requests">
              <div className="rail-head">
                <h1 className="h1">Requests</h1>
                <button className="btn-sm" onClick={() => { setComposing(true); setError(null); reveal(); }}>Create test request</button>
              </div>
              {GROUPS.map(([state, color]) => {
                const items = snap.requests.filter(r => r.state === state);
                if (!items.length) return null;
                return (
                  <section className="group" key={state}>
                    <h2 className="group-title"><span className="dot" style={{ background: color }} />{state} · {items.length}</h2>
                    {items.map(r => {
                      const o = r.run.intake?.data;
                      const company = r.email.test && o?.customer && !/unknown|test/i.test(o.customer) ? o.customer : r.email.company;
                      return (
                        <button key={r.email.id} className="item" aria-current={sel?.email.id === r.email.id} onClick={() => select(r.email.id)}>
                          <span className="item-top"><span className="item-name">{company}</span><span className="item-time">{r.email.receivedAt}</span></span>
                          <span className="item-sum">{o?.pallets ? o.pallets + ' pallets to ' + o.destination + (/not stated/i.test(o.deliverBy) ? '' : ' · by ' + o.deliverBy.split(',')[0]) : r.email.subject}</span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </aside>

            <article className="card" aria-label="Request">
              {composing ? (
                <Composer examples={snap.examples} draft={draft} setDraft={setDraft} busy={pending === 'new'} error={error}
                  onCancel={() => setComposing(false)}
                  onSend={async () => {
                    const res = await post('/api/requests', { body: draft }, 'new');
                    if (res?.ok) { setDraft(''); setComposing(false); setSelId(res.id); }
                  }} />
              ) : sel ? (
                <Detail req={sel} busy={pending === sel.email.id} error={error} open={open} toggle={toggle} auto={auto} next={next}
                  onApprove={() => post('/api/requests/' + sel.email.id + '/approve', {}, sel.email.id)}
                  onAsk={() => post('/api/requests/' + sel.email.id + '/ask', {}, sel.email.id)}
                  onNext={() => next && select(next.email.id)} onLoads={() => setView('loads')} />
              ) : (
                <div className="empty"><h2 className="h1">Pick a request</h2><p className="sub">You will see what the agents did and where they are waiting for you.</p></div>
              )}
            </article>
          </div>
        )}
        {view === 'loads' && <Loads snap={snap} />}
        {view === 'carriers' && <Carriers snap={snap} />}
        {view === 'activity' && <Activity snap={snap} onReset={() => { post('/api/reset'); setSelId('e1'); setView('requests'); }} />}
      </main>
    </>
  );
}

function Composer(p: { examples: Snapshot['examples']; draft: string; setDraft: (s: string) => void; busy: boolean; error: string | null; onSend: () => void; onCancel: () => void }) {
  return (
    <div className="composer rise">
      <div>
        <h2 className="h1-lg">Send a test request</h2>
        <p className="sub">Write it the way a customer would. The intake agent reads it the moment it lands.</p>
      </div>
      <div className="pills" role="group" aria-label="Examples">
        {p.examples.map(x => <button key={x.label} className="pill" aria-pressed={p.draft === x.text} onClick={() => p.setDraft(x.text)}>{x.label}</button>)}
      </div>
      <label className="sub" htmlFor="draft" style={{ marginBottom: -12 }}>Customer message</label>
      <textarea id="draft" value={p.draft} onChange={e => p.setDraft(e.target.value)} placeholder="e.g. Hi, we need 8 pallets of chilled produce sent to Ipoh by Wednesday 18 Nov." />
      {p.error && <div className="error">{p.error}</div>}
      <div className="row">
        <button className="btn btn-primary" disabled={!p.draft.trim() || p.busy} onClick={p.onSend}>{p.busy ? 'Intake agent is reading…' : 'Send to the inbox'}</button>
        <button className="link" style={{ color: 'var(--ink2)' }} onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Detail({ req, busy, error, open, toggle, auto, next, onApprove, onAsk, onNext, onLoads }: {
  req: Req; busy: boolean; error: string | null; open: Record<string, boolean>; toggle: (k: string) => void; auto: boolean; next?: Req;
  onApprove: () => void; onAsk: () => void; onNext: () => void; onLoads: () => void;
}) {
  const { email: e, run: R } = req, id = e.id, g = stage(R);
  const o = R.intake?.data, p = R.dispatch?.data, c = R.carrier?.data, bk = R.booking;
  const keys = ['intake', 'dispatch', 'carrier', 'booking'] as const, gi = keys.indexOf(g.key);
  const fn = o ? firstName(o.contact) : '';
  const review = g.status === 'review', blocked = g.status === 'blocked', booked = g.key === 'booking';
  const nextAgent = g.key === 'intake' ? 'Dispatch agent is planning the load…' : g.key === 'dispatch' ? 'Carrier agent is getting quotes and negotiating…' : 'Booking the truck and drafting the confirmation…';
  const by = (k: 'intake' | 'dispatch' | 'carrier') => (R[k]?.by === 'agent' ? 'by the agent' : 'by you');

  const trace = useMemo(() => (['intake', 'dispatch', 'carrier'] as const).flatMap(k => {
    const s = R[k]; if (!s?.calls?.length) return [];
    const src = s.source === 'model' ? 'reasoning: model' : s.source === 'seeded' ? 'read on arrival (sample data)' : 'reasoning: scripted';
    return [{ head: true, t: AGENT_NAME[k] + ' · ' + src }, ...s.calls.map(x => ({ head: false, t: x.tool + ' → ' + short(x.output) })), ...s.notes.map(n => ({ head: false, note: true, t: n }))];
  }), [R]);

  let gate: { label: string; act: () => void; note: string; warn?: boolean } | null = null;
  if (review && g.key === 'intake' && o) gate = blockersOf(o).length
    ? { label: fn ? 'Ask ' + fn + ' for the details' : 'Ask the customer for the details', act: onAsk, note: 'No load can be planned until the customer replies.' }
    : { label: 'Confirm order', act: onApprove, note: auto && o.missing.length ? 'Held for you: the email is missing ' + list(o.missing.map(m => m.toLowerCase())) + '.' : 'Next, the dispatch agent plans the load. Nothing books until you approve the rate.' };
  if (review && g.key === 'dispatch') gate = { label: 'Approve plan', act: onApprove, note: 'Next, the carrier agent gets quotes and negotiates.' };
  if (review && g.key === 'carrier' && c && p) gate = { label: 'Book at ' + rm(c.finalRm), act: onApprove, warn: !c.withinBenchmark,
    note: c.withinBenchmark ? 'Books ' + p.loadId + ' with ' + c.pick + ' and drafts the confirmation for ' + (fn || 'the customer') + '.' : 'Held for you: ' + rm(c.finalRm - c.benchmarkRm) + ' above the lane benchmark. Auto-run never books above it.' };

  const nYou = (['intake', 'dispatch', 'carrier'] as const).filter(k => R[k]?.by === 'you').length;

  return (
    <div>
      <div className="card-head">
        <div className="from">{(o?.customer && !/unknown|test/i.test(o.customer) ? o.customer : e.company) + ' · ' + (e.test ? (o?.contact || 'Test request').replace(/\s*\(.*\)\s*$/, '') : e.from) + ' · ' + e.receivedAt}</div>
        {/* Test emails have no real subject line, so title the card from the parsed order instead of a cut-off first sentence. */}
        <h2 className="subject">{e.test && o?.pallets ? o.pallets + ' pallets to ' + o.destination : e.subject}</h2>
        <ol className="steps" aria-label="Progress">
          {STEP_LABELS.map((l, i) => {
            const st = i < gi ? 'done' : i > gi ? '' : g.status === 'done' ? 'done' : 'active';
            return <li key={l} className={st} aria-current={st === 'active' ? 'step' : undefined}>{l}</li>;
          })}
        </ol>
        {gi > 0 && (
          <ul className="done-list">
            {o && <li><span className="tick" aria-hidden="true">✓</span><span><b>Order confirmed {by('intake')}</b> · {o.pallets} pallets to {o.destination}</span></li>}
            {gi > 1 && p && <li><span className="tick" aria-hidden="true">✓</span><span><b>Plan approved {by('dispatch')}</b> · {(p.consolidate ? 'added to ' : 'new load ') + p.loadId}, {p.dock}, {p.window}</span></li>}
            {gi > 2 && c && <li><span className="tick" aria-hidden="true">✓</span><span><b>Rate approved {by('carrier')}</b> · {c.pick} at {rm(c.finalRm)}</span></li>}
          </ul>
        )}
      </div>
      <div className="rule" />

      <section className="body" aria-live="polite">
        {busy ? (
          <>
            <div className="working"><span className="dot pulse" style={{ width: 10, height: 10, background: 'var(--blue)' }} />{nextAgent}</div>
            <div className="facts" aria-hidden="true"><span className="skel pulse" /><span className="skel pulse" /><span className="skel pulse" /></div>
          </>
        ) : (
          <>
            {!booked && <div className="eyebrow"><Chip />{AGENT_NAME[g.key as keyof typeof AGENT_NAME]} · {blocked ? 'waiting on the customer' : g.key === 'intake' ? 'built this order from the email' : g.key === 'dispatch' ? 'planned the load' : 'got quotes and negotiated'}</div>}

            {g.key === 'intake' && o && (review || blocked) && (
              <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p className="lead">{(o.pallets ? o.pallets + ' pallets' : 'An unknown number of pallets') + ' to ' + (DIST[o.destination] ? o.destination : 'an unstated city') + (/not stated/i.test(o.deliverBy) ? ', with no delivery date.' : ', by ' + o.deliverBy + '.')}</p>
                {o.missing.length > 0 && (
                  <div className="note">
                    <div><div className="note-title">{blockersOf(o).length ? 'Can’t plan a load yet' : 'Not in the email: ' + list(o.missing.map(m => m.toLowerCase()))}</div>
                      <div className="note-text">{blockersOf(o).length ? 'The agent leaves gaps blank instead of guessing.' : 'The agent left it blank instead of guessing. The confirmation will ask ' + (fn || 'the customer') + ' for it.'}</div></div>
                  </div>
                )}
                <dl className="facts">
                  <Fact k="Commodity" v={o.commodity} /><Fact k="Temperature" v={cap1(o.temp)} />
                  <Fact k="Equipment" v={o.equipment.length ? o.equipment.join(', ') : 'Standard'} /><Fact k="Budget" v={o.budgetRm ? rm(o.budgetRm) : 'Not stated'} mute={!o.budgetRm} />
                </dl>
                {blocked && R.reply && <><div className="small">Reply drafted to {fn || 'the customer'}</div><div className="quote-box">{R.reply}</div></>}
              </div>
            )}

            {g.key === 'dispatch' && review && p && o && (
              <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div><p className="lead">{p.consolidate ? 'Add it to ' + p.loadId + ', already going to ' + o.destination : 'Open a new load, ' + p.loadId}</p>
                  <p className="sub">{p.consolidate ? 'One truck carries both orders.' : 'No open load matches, so this order gets its own truck.'}</p></div>
                <div>
                  <div className="bar" role="img" aria-label={p.total + ' of ' + CAP + ' pallets used'}>
                    <span style={{ width: (p.onTruck / CAP) * 100 + '%' }} /><span style={{ width: (Math.min(CAP, p.total) - p.onTruck) / CAP * 100 + '%' }} />
                  </div>
                  <div className="bar-legend"><span>{p.onTruck ? p.onTruck + ' already on board, ' + (p.total - p.onTruck) + ' from this order' : p.total + ' pallets from this order'}</span><b style={{ color: 'var(--ink)' }}>{p.total} of {CAP} pallets</b></div>
                </div>
                <dl className="facts"><Fact k="Truck" v={p.truck} /><Fact k="Dock" v={p.dock} /><Fact k="Pickup" v={p.window} /></dl>
                <p className="why"><b>Why: </b>{p.rationale}</p>
              </div>
            )}

            {g.key === 'carrier' && review && c && (
              <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div>
                  <div className="price"><span className="price-big">{rm(c.finalRm)}</span><span className="price-was">{rm(c.quoteRm)}</span>
                    <span className={'chip ' + (c.withinBenchmark ? 'good' : 'warn')}>{c.benchmarkRm >= c.finalRm ? (c.benchmarkRm === c.finalRm ? 'At the lane benchmark' : rm(c.benchmarkRm - c.finalRm) + ' under the lane benchmark') : rm(c.finalRm - c.benchmarkRm) + ' over the lane benchmark'}</span></div>
                  <p className="sub" style={{ fontSize: 15 }}>{c.pick} · {c.quotes.find(q => q.carrier === c.pick)?.onTimePct}% on time</p>
                </div>
                <div>
                  <div className="label">Quotes from permitted hauliers</div>
                  <ul className="quotes">
                    {[...c.quotes].sort((a, b) => a.quoteRm - b.quoteRm).map((q, i, all) => {
                      const tags = [q.carrier === c.pick && 'Picked', i === 0 && all.length > 1 && 'Cheapest', q.onTimePct === Math.max(...all.map(x => x.onTimePct)) && all.length > 1 && 'Most on time'].filter(Boolean).join(' · ');
                      return <li key={q.carrier} className={q.carrier === c.pick ? 'picked' : ''}><span>{q.carrier}{tags && <span className="tag">{tags}</span>}</span><span className="small" style={{ fontSize: 14 }}>{q.onTimePct}% on time</span><span>{rm(q.quoteRm)}</span></li>;
                    })}
                  </ul>
                  {c.excluded.length > 0 && <div className="small" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>Not asked: {list(c.excluded)}.</div>}
                </div>
                <p className="why"><b>Why {c.pick}: </b>{c.reason}</p>
                <div>
                  <button className="link" aria-expanded={!!open[id + 'neg']} onClick={() => toggle(id + 'neg')}>{open[id + 'neg'] ? 'Hide' : 'Read'} the negotiation (2 messages)</button>
                  {open[id + 'neg'] && <div className="bubbles"><div className="bubble"><small>Carrier agent to {c.pick}</small>{c.message}</div><div className="bubble them"><small>{c.pick} · simulated reply</small>{c.reply}</div></div>}
                </div>
              </div>
            )}

            {booked && p && c && (
              <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="booked-head">
                  <span className="booked-icon"><Truck color="#15803d" size={26} /></span>
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}><div className="h1-lg">Booked · {p.loadId}</div><div className="sub" style={{ marginTop: 0 }}>{c.pick} · {rm(c.finalRm)} · pickup {p.window}, {p.dock}</div></div>
                  {req.bookedInMs != null && <div className="booked-time"><span className="small">Request to booked</span><b>{clock(req.bookedInMs)}</b></div>}
                </div>
                <p>{nYou ? 'You made ' + nYou + ' decision' + (nYou === 1 ? '' : 's') + '. The agents read the email, planned the load, got quotes and negotiated the rate.' : 'The agents handled this one alone. Nothing broke a limit, so nothing needed you.'}</p>
                <div>
                  <button className="link" disabled={bk?.status !== 'done'} aria-expanded={!!open[id + 'conf']} onClick={() => toggle(id + 'conf')}>{bk?.status === 'done' ? (open[id + 'conf'] ? 'Hide' : 'Read') + ' the confirmation for ' + (o?.contact || 'the customer') : 'Drafting the confirmation…'}</button>
                  {open[id + 'conf'] && bk?.data && <div className="quote-box" style={{ marginTop: 10 }}>{bk.data.confirmation}</div>}
                </div>
                <div className="row">
                  {next && <button className="btn btn-primary" onClick={onNext}>Next: {next.email.company} →</button>}
                  <button className="btn btn-ghost" onClick={onLoads}>View in Loads</button>
                </div>
              </div>
            )}

            {error && <div className="error">{error}</div>}
            <div className="links">
              <button className="link" aria-expanded={!!open[id + 'mail']} onClick={() => toggle(id + 'mail')}>{open[id + 'mail'] ? 'Hide' : 'View'} the email</button>
              {trace.length > 0 && <button className="link" aria-expanded={!!open[id + 'trace']} onClick={() => toggle(id + 'trace')}>{open[id + 'trace'] ? 'Hide tool calls' : 'How the agents worked'}</button>}
            </div>
            {open[id + 'mail'] && <blockquote className="quote-box" style={{ margin: 0 }}>{e.body}</blockquote>}
            {open[id + 'trace'] && <div className="trace">{trace.map((t, i) => <span key={i} className={t.head ? 'head' : 'note' in t ? 'note' : ''}>{t.t}</span>)}</div>}
          </>
        )}
      </section>

      {gate && !busy && (
        <div className="gate">
          <button className="btn btn-primary" onClick={gate.act}>{gate.label}</button>
          <span className={'gate-note' + (gate.warn ? ' warn' : '')}>{gate.note}</span>
        </div>
      )}
    </div>
  );
}

function Fact({ k, v, mute }: { k: string; v: string; mute?: boolean }) {
  return <div className="fact"><dt>{k}</dt><dd className={mute ? 'mute' : ''}>{v}</dd></div>;
}

/** One-line summary of a tool output for the trace. */
function short(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.length + ' result' + (x.length === 1 ? '' : 's');
  if (x && typeof x === 'object') {
    const s = Object.entries(x as Record<string, unknown>)
      .map(([k, v]) => k.replace(/_/g, ' ') + ': ' + (Array.isArray(v) ? v.length : typeof v === 'object' ? '…' : String(v)))
      .join(' · ');
    return s.length > 110 ? s.slice(0, 107) + '…' : s;
  }
  return String(x);
}

function Loads({ snap }: { snap: Snapshot }) {
  const times = snap.requests.map(r => r.bookedInMs).filter((x): x is number => x != null);
  const booked = snap.loads.filter(l => l.status === 'Booked').length;
  const cols = { gridTemplateColumns: '90px 1.3fr 80px 90px 1.6fr 1.3fr 100px 100px' };
  return (
    <>
      <div className="view-head">
        <div><h1 className="h1-lg">Loads</h1><p className="sub">Every truck the agents planned, and who is carrying it.</p></div>
        <div className="stats">
          <div className="stat"><b>{booked}</b><span>Booked</span></div>
          <div className="stat"><b>{snap.loads.length - booked}</b><span>Waiting for a carrier</span></div>
          <div className="stat"><b style={{ color: times.length ? 'var(--green)' : undefined }}>{times.length ? clock(Math.min(...times)) : '–'}</b><span>Fastest booking</span></div>
        </div>
      </div>
      <div className="table-card"><div className="table" role="table" aria-label="Loads">
        <div className="tr th" role="row" style={cols}>{['Load', 'Lane', 'Pallets', 'Temp', 'Pickup', 'Carrier', 'Rate', 'Status'].map(h => <span key={h} role="columnheader">{h}</span>)}</div>
        {snap.loads.map(l => (
          <div className="tr" role="row" key={l.id} style={cols}>
            <span role="cell" style={{ fontWeight: 600 }}>{l.id}</span><span role="cell">Shah Alam DC → {l.dest}</span><span role="cell">{l.pallets} / {CAP}</span><span role="cell">{cap1(l.temp)}</span>
            <span role="cell" style={{ color: l.pickup ? undefined : 'var(--muted)' }}>{l.pickup || 'Not scheduled'}</span><span role="cell" style={{ color: l.carrier ? undefined : 'var(--muted)' }}>{l.carrier || 'Unassigned'}</span>
            <span role="cell" style={{ color: l.rateRm ? undefined : 'var(--muted)' }}>{l.rateRm ? rm(l.rateRm) : 'Not set'}</span>
            <span role="cell"><span className="status" style={l.status === 'Booked' ? { background: 'var(--green-tint)', color: 'var(--green-ink)' } : { background: '#f1f0ed', color: 'var(--ink2)' }}>{l.status}</span></span>
          </div>
        ))}
      </div></div>
    </>
  );
}

function Carriers({ snap }: { snap: Snapshot }) {
  const cols = { gridTemplateColumns: '1.4fr 1.6fr 1.3fr 100px 100px' };
  return (
    <>
      <div className="view-head"><div><h1 className="h1-lg">Carriers</h1><p className="sub">The carrier agent only asks hauliers with a valid APAD Class A permit and the right equipment.</p></div></div>
      <div className="table-card"><div className="table" role="table" aria-label="Carriers" style={{ minWidth: 820 }}>
        <div className="tr th" role="row" style={cols}>{['Carrier', 'Equipment', 'APAD permit', 'RM per km', 'On time'].map(h => <span key={h} role="columnheader">{h}</span>)}</div>
        {snap.carriers.map(c => (
          <div className="tr" role="row" key={c.name} style={cols}>
            <span role="cell" style={{ fontWeight: 600 }}>{c.name}</span><span role="cell" style={{ color: 'var(--ink2)' }}>{c.equipment.join(', ')}</span>
            <span role="cell" style={c.permitValid ? undefined : { color: 'var(--amber)', fontWeight: 600 }}>{c.permit}</span><span role="cell">{c.ratePerKm.toFixed(2)}</span><span role="cell">{c.onTimePct}%</span>
          </div>
        ))}
      </div></div>
    </>
  );
}

function Activity({ snap, onReset }: { snap: Snapshot; onReset: () => void }) {
  return (
    <>
      <div className="view-head">
        <div><h1 className="h1-lg">Activity</h1><p className="sub">Everything the agents did, and every call you made. Tools and carrier replies are mocked.</p></div>
        <button className="btn-sm" onClick={onReset}>Start the demo over</button>
      </div>
      <ol className="log">
        {snap.log.map((l, i) => (
          <li key={i}><span className="small" style={{ fontSize: 14 }}>{l.at}</span><span className={'actor' + (l.actor === 'You' ? ' you' : '')}>{l.actor}</span><span>{l.text}</span></li>
        ))}
      </ol>
    </>
  );
}
