// Typed tool adapters. Agents only act through these, and every call is recorded on the step
// so the audit log shows exactly what each agent looked at.
import type Anthropic from '@anthropic-ai/sdk';
import { CAP, city, eligibleCarriers, laneBenchmark, quoteFor, r10, rm } from '../domain/rules';
import type { Load, Temp, ToolCall } from '../domain/types';
import { CARRIERS, SLOTS } from './data';

export interface ToolCtx {
  requestId: string;
  loads: Load[];
  reserved: Record<string, string>; // loadId -> requestId holding it while a plan waits for approval
  calls: ToolCall[];
}

export interface AgentTool<I = any> {
  def: Anthropic.Messages.Tool;
  run: (input: I, ctx: ToolCtx) => unknown;
}

export function exec<I>(tool: AgentTool<I>, input: I, ctx: ToolCtx) {
  let output: unknown;
  try { output = tool.run(input, ctx); } catch (e) { output = { error: (e as Error).message }; }
  ctx.calls.push({ tool: tool.def.name, input, output });
  return output;
}

const tempSchema = { type: 'string', enum: ['ambient', 'chilled', 'frozen'] };

export function openLoads(ctx: ToolCtx, destination?: string) {
  const dest = destination ? city(destination) ?? destination : null;
  return ctx.loads.filter(l => l.status === 'Planned' && !l.carrier && (!dest || l.dest === dest)
    && (!ctx.reserved[l.id] || ctx.reserved[l.id] === ctx.requestId));
}

export const tmsOpenLoads: AgentTool<{ destination?: string }> = {
  def: {
    name: 'tms_open_loads',
    description: 'List planned loads that have no carrier yet. Filter by destination city to find loads an order could share.',
    input_schema: { type: 'object', properties: { destination: { type: 'string', description: 'Destination city' } } }
  },
  run: (i, ctx) => openLoads(ctx, i.destination).map(l => ({ load_id: l.id, destination: l.dest, pallets_on_board: l.pallets, temp: l.temp, truck_capacity: CAP }))
};

export const wmsDockSlots: AgentTool<Record<string, never>> = {
  def: {
    name: 'wms_dock_slots',
    description: 'List free outbound dock slots at Shah Alam DC, in time order. Transit to any served lane is 3 to 6 hours the same day.',
    input_schema: { type: 'object', properties: {} }
  },
  run: () => SLOTS.map((s, i) => ({ slot_index: i, dock: s.dock, window: s.window }))
};

export const carriersEligible: AgentTool<{ temp: Temp; equipment?: string[] }> = {
  def: {
    name: 'carriers_eligible',
    description: 'List carriers that may be asked for a quote: the right equipment and a valid APAD Class A permit. Also lists carriers excluded for a lapsed permit.',
    input_schema: { type: 'object', properties: { temp: tempSchema, equipment: { type: 'array', items: { type: 'string' } } }, required: ['temp'] }
  },
  run: i => {
    const { eligible, excluded } = eligibleCarriers(CARRIERS, i.temp, i.equipment ?? []);
    return { eligible: eligible.map(c => ({ name: c.name, on_time_pct: c.onTimePct, equipment: c.equipment })), excluded: excluded.map(c => ({ name: c.name, reason: 'APAD permit ' + c.permit.toLowerCase() })) };
  }
};

export const carriersQuotes: AgentTool<{ carriers: string[]; destination: string; temp: Temp; pallets_on_truck: number; equipment?: string[] }> = {
  def: {
    name: 'carriers_request_quotes',
    description: 'Request quotes for a load from named eligible carriers. Carriers that are not eligible are ignored.',
    input_schema: {
      type: 'object',
      properties: { carriers: { type: 'array', items: { type: 'string' } }, destination: { type: 'string' }, temp: tempSchema, pallets_on_truck: { type: 'number' }, equipment: { type: 'array', items: { type: 'string' } } },
      required: ['carriers', 'destination', 'temp', 'pallets_on_truck']
    }
  },
  run: i => {
    const { eligible } = eligibleCarriers(CARRIERS, i.temp, i.equipment ?? []);
    const dest = city(i.destination) ?? i.destination;
    return eligible.filter(c => i.carriers.includes(c.name)).map(c => {
      const q = quoteFor(c, dest, i.temp, i.pallets_on_truck);
      return { carrier: q.carrier, quote_rm: q.quoteRm, on_time_pct: q.onTimePct };
    });
  }
};

export const tmsBenchmark: AgentTool<{ destination: string; temp: Temp; pallets_on_truck: number }> = {
  def: {
    name: 'tms_lane_benchmark',
    description: 'Benchmark rate in RM for a lane, from recent bookings. Bookings above it always wait for the dispatcher.',
    input_schema: { type: 'object', properties: { destination: { type: 'string' }, temp: tempSchema, pallets_on_truck: { type: 'number' } }, required: ['destination', 'temp', 'pallets_on_truck'] }
  },
  run: i => ({ benchmark_rm: laneBenchmark(city(i.destination) ?? i.destination, i.temp, i.pallets_on_truck) })
};

/** Simulated carrier: accepts a counter at 95% of quote or better, otherwise meets halfway. Called by code, not the model. */
export const carriersCounter: AgentTool<{ carrier: string; quote_rm: number; counter_rm: number; pickup: string }> = {
  def: {
    name: 'carriers_send_counter',
    description: 'Send a counter-offer to a carrier and return its reply.',
    input_schema: { type: 'object', properties: { carrier: { type: 'string' }, quote_rm: { type: 'number' }, counter_rm: { type: 'number' }, pickup: { type: 'string' } }, required: ['carrier', 'quote_rm', 'counter_rm', 'pickup'] }
  },
  run: i => {
    const floor = r10(i.quote_rm * 0.95);
    if (i.counter_rm >= floor) return { agreed_rm: i.counter_rm, reply: 'Agreed at ' + rm(i.counter_rm) + '. Truck confirmed for ' + i.pickup + '.' };
    const meet = Math.min(i.quote_rm, r10((i.counter_rm + i.quote_rm) / 2));
    return { agreed_rm: meet, reply: 'We cannot do ' + rm(i.counter_rm) + ' on this lane. We can meet you at ' + rm(meet) + ' and confirm the truck for ' + i.pickup + '.' };
  }
};
