// In-memory store for the POC. db/schema.sql shows the Postgres tables the pilot uses instead;
// the orchestrator only touches state through this module, so the swap stays local.
import type { Actor, Autonomy, Email, Load, LogEntry, Run } from '../domain/types';
import { normalizeOrder } from '../domain/rules';
import { SEED_EMAILS, SEED_LOADS } from '../tools/data';

export interface State {
  emails: Email[];
  runs: Record<string, Run>;
  loads: Load[];
  log: LogEntry[];
  autonomy: Autonomy;
  seq: number;
  mailN: number;
  reserved: Record<string, string>;
  arrivedAt: Record<string, number>;
  bookedIn: Record<string, number>;
  busy: Record<string, boolean>;
}

export const clock = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });

function seed(): State {
  const runs: Record<string, Run> = {};
  const arrivedAt: Record<string, number> = {};
  for (const e of SEED_EMAILS) {
    const order = normalizeOrder(e.read, e.company);
    // The intake agent reads mail on arrival, so seeded requests open with the order already extracted.
    runs[e.id] = { intake: { status: 'review', data: order, source: 'seeded', calls: [
      { tool: 'mail_read', input: { id: e.id }, output: '1 message' },
      { tool: 'submit_order', input: order, output: order.missing.length ? order.missing.length + ' field(s) missing' : 'all required fields found' }
    ], notes: [] } };
    arrivedAt[e.id] = Date.now();
  }
  return {
    emails: SEED_EMAILS.map(({ read: _read, ...e }) => e),
    runs,
    loads: SEED_LOADS.map(l => ({ ...l })),
    log: [
      { at: '09:20', actor: 'Intake', text: 'Read Ladang Segar Dairy: 22 pallets chilled to Kuantan. Total weight not stated.' },
      { at: '08:47', actor: 'Intake', text: 'Read Lumen Electronics: 6 pallets to Johor Bahru.' },
      { at: '08:12', actor: 'Intake', text: 'Read Kedai Harian Sdn Bhd: 14 pallets to Penang.' },
      { at: '07:41', actor: 'Carrier', text: 'Booked LD-2288 to Ipoh with Utara Haulage at RM 1,220.' },
      { at: '07:15', actor: 'Dispatch', text: 'Opened LD-2291 to Penang with 10 pallets, waiting to consolidate.' }
    ],
    autonomy: 'approve', seq: 2296, mailN: 3, reserved: {}, arrivedAt, bookedIn: {}, busy: {}
  };
}

// Survives Next.js hot reloads in development.
const g = globalThis as unknown as { __dockhand?: State };
export const db = (): State => (g.__dockhand ??= seed());
export const resetStore = () => { g.__dockhand = seed(); };

export function log(actor: Actor, text: string) {
  const s = db();
  s.log = [{ at: clock(), actor, text }, ...s.log].slice(0, 50);
}
