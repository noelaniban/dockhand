// The guardrails sit in code after the model, so a wrong model answer cannot get through.
// These tests stand in a fake Claude client that returns bad answers on purpose.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCtx } from '@/lib/tools/tools';

const api = vi.hoisted(() => ({ replies: [] as unknown[], requests: [] as any[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: unknown) => {
        api.requests.push(req);
        const next = api.replies.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    };
  }
}));

const toolUse = (name: string, input: unknown) => ({ content: [{ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input }] });

const { dispatchAgent, carrierAgent, intakeAgent } = await import('@/lib/agents/agents');
const { normalizeOrder } = await import('@/lib/domain/rules');
const { SEED_EMAILS, SEED_LOADS } = await import('@/lib/tools/data');

const ctx = (): ToolCtx => ({ requestId: 't1', loads: SEED_LOADS.map(l => ({ ...l })), reserved: {}, calls: [] });
const penang = normalizeOrder(SEED_EMAILS[0].read, 'Kedai Harian Sdn Bhd'); // 14 pallets, Penang, by Thu 19 Nov

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.DOCKHAND_SCRIPTED = '0';
  api.replies = [];
  api.requests = [];
});

describe('dispatch guardrails on model output', () => {
  it('rejects a consolidation that does not fit and a slot that misses the deadline', async () => {
    api.replies = [
      toolUse('tms_open_loads', { destination: 'Penang' }),
      toolUse('submit_plan', { decision: 'consolidate', load_id: 'LD-2290', slot_index: 5, rationale: 'Share the JB truck.' })
    ];
    const c = ctx();
    const r = await dispatchAgent(penang, c, () => 'LD-9000');
    expect(r.source).toBe('model');
    expect(r.data).toMatchObject({ consolidate: false, loadId: 'LD-9000', window: 'Wed 18 Nov, 15:00–16:00' });
    expect(r.notes.join(' ')).toMatch(/consolidation rejected/);
    expect(r.notes.join(' ')).toMatch(/dock slot changed/);
    expect(c.calls[0].tool).toBe('tms_open_loads'); // the model's own tool call is in the audit trail
    expect(c.reserved).toEqual({});
  });

  it('keeps a good model plan as it is', async () => {
    api.replies = [toolUse('submit_plan', { decision: 'consolidate', load_id: 'LD-2291', slot_index: 3, rationale: 'Fits with 2 to spare.' })];
    const c = ctx();
    const r = await dispatchAgent(penang, c, () => 'LD-9000');
    expect(r.data).toMatchObject({ consolidate: true, loadId: 'LD-2291', total: 24, rationale: 'Fits with 2 to spare.' });
    expect(r.notes).toEqual([]);
    expect(c.reserved).toEqual({ 'LD-2291': 't1' });
  });
});

describe('carrier guardrails on model output', () => {
  const plan = { consolidate: true, loadId: 'LD-2291', onTruck: 10, total: 24, truck: '40 ft curtain-sider', dock: 'Dock 5', window: 'Wed 18 Nov, 15:00–16:00', rationale: '' };

  it('will not use a carrier whose APAD permit has lapsed', async () => {
    api.replies = [toolUse('submit_deal', { carrier: 'Semenanjung Freight', counter_rm: 1900, reason: 'Cheapest.', message: 'Hi' })];
    const r = await carrierAgent(penang, plan, ctx());
    expect(r.data.pick).not.toBe('Semenanjung Freight');
    expect(r.notes.join(' ')).toMatch(/not an eligible carrier/);
  });

  it('clamps a counter-offer that is too aggressive', async () => {
    api.replies = [toolUse('submit_deal', { carrier: 'Lebuhraya Express', counter_rm: 500, reason: 'Most on time.', message: 'Hi' })];
    const r = await carrierAgent(penang, plan, ctx());
    expect(r.data.pick).toBe('Lebuhraya Express');
    expect(r.data.counterRm).toBe(Math.round((r.data.quoteRm * 0.88) / 10) * 10);
    expect(r.notes.join(' ')).toMatch(/counter-offer kept/);
  });
});

describe('model failures', () => {
  it('fall back to the scripted agent and say so', async () => {
    api.replies = [new Error('overloaded')];
    const r = await intakeAgent({ ...SEED_EMAILS[1], test: false }, ctx());
    expect(r.source).toBe('scripted');
    expect(r.notes[0]).toMatch(/Model call failed \(overloaded\)/);
    expect(r.data).toMatchObject({ pallets: 6, destination: 'Johor Bahru' });
  });

  it('nudge a model that answers in prose, without forcing tool use', async () => {
    api.replies = [
      { content: [{ type: 'text', text: 'I think a new load makes sense.' }] },
      toolUse('submit_plan', { decision: 'new_load', load_id: null, slot_index: 0, rationale: 'x' })
    ];
    const r = await dispatchAgent(penang, ctx(), () => 'LD-9001');
    expect(r.source).toBe('model');
    expect(api.requests).toHaveLength(2);
    expect(api.requests.every(q => q.tool_choice.type === 'auto')).toBe(true); // Sonnet 5.5 rejects forced tool use with thinking on
    expect(api.requests[1].messages.at(-1).content).toMatch(/Call submit_plan now/);
  });

  it('give up after the turn limit and run the scripted agent', async () => {
    api.replies = Array.from({ length: 6 }, () => toolUse('wms_dock_slots', {}));
    const r = await dispatchAgent(penang, ctx(), () => 'LD-9002');
    expect(api.requests).toHaveLength(6);
    expect(r.source).toBe('scripted');
    expect(r.notes[0]).toMatch(/did not submit an answer/);
    expect(r.data.loadId).toBe('LD-2291');
  });
});
