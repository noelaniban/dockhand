// Business rules and guardrails. Everything here is deterministic and runs after the model answers,
// so capacity, deadlines, rate ceilings and permits never depend on a prompt.
import type { Carrier, Order, Quote, Slot, Temp } from './types';

export const CAP = 26; // pallets per truck, simplified; real capacity per truck type comes from the TMS

/** Road distance in km from Shah Alam DC. Only these lanes are served in the POC. */
export const DIST: Record<string, number> = {
  Penang: 355, 'Johor Bahru': 330, Kuantan: 250, Ipoh: 200, Melaka: 145, 'Kuala Terengganu': 440, Seremban: 70
};

export const LANES = Object.keys(DIST);

export const rm = (n: number) => 'RM ' + Math.round(n).toLocaleString('en-US');
export const r10 = (n: number) => Math.round(n / 10) * 10;
export const list = (a: string[]) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
export const cap1 = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export function firstName(contact: string): string {
  const n = String(contact || '').trim();
  return !n || /unknown|sender|not stated|customer/i.test(n) ? '' : n.split(/\s+/)[0];
}

/** Maps free text to a served lane, or null. Handles the common "JB" shorthand. */
export function city(text: string): string | null {
  const t = String(text || '').toLowerCase();
  return LANES.find(c => t.includes(c.toLowerCase()) || (c === 'Johor Bahru' && /\bjb\b/.test(t))) ?? null;
}

export function dayOf(deadline: string): number | null {
  const m = String(deadline || '').match(/(\d{1,2})\s*nov/i);
  return m ? Number(m[1]) : null;
}

/** A slot is safe if pickup is the day before the deadline, or very early on the day itself. */
export function slotOk(slot: Slot, deadline: string): boolean {
  const d = dayOf(deadline);
  return !d || slot.day < d || (slot.day === d && slot.hour <= 6);
}

/** Latest safe slot for the deadline; the earliest slot when none is safe or no deadline was given. */
export function pickSlot(slots: Slot[], deadline: string): number {
  if (!dayOf(deadline)) return 0;
  let best = -1;
  slots.forEach((s, i) => { if (slotOk(s, deadline)) best = i; });
  return best >= 0 ? best : 0;
}

export function truckFor(temp: Temp, total: number): string {
  return temp !== 'ambient' ? 'Reefer trailer' : total <= 10 ? '10-tonne rigid' : '40 ft curtain-sider';
}

/** Pricing factor: reefers cost more, small loads go on a smaller truck. */
const factor = (temp: Temp, total: number) => (temp !== 'ambient' ? 1.25 : 1) * (total <= 10 ? 0.7 : 1);

export function laneBenchmark(destination: string, temp: Temp, total: number): number {
  return r10((DIST[destination] ?? 300) * 6.2 * factor(temp, total));
}

export function quoteFor(c: Carrier, destination: string, temp: Temp, total: number): Quote {
  return { carrier: c.name, quoteRm: r10((DIST[destination] ?? 300) * c.ratePerKm * factor(temp, total)), onTimePct: c.onTimePct, equipment: c.equipment };
}

/** Which carriers the agent may even ask: right equipment and a valid APAD Class A permit. */
export function eligibleCarriers(all: Carrier[], temp: Temp, equipment: string[]) {
  const reefer = temp !== 'ambient';
  const needsTail = equipment.some(e => /tail/i.test(e));
  const typeOk = (c: Carrier) => (reefer ? c.equipment.includes('Reefer') : !c.equipment.includes('Reefer'));
  const excluded = all.filter(c => typeOk(c) && !c.permitValid);
  let eligible = all.filter(c => c.permitValid && typeOk(c) && (!needsTail || c.equipment.includes('Tail-lift')));
  if (!eligible.length) eligible = all.filter(c => c.permitValid && typeOk(c));
  return { eligible, excluded };
}

/** Counter-offers stay between 88% and the full quote, whatever the model proposed. */
export function clampCounter(quoteRm: number, proposed: number | undefined): number {
  const ask = Number.isFinite(proposed) && proposed! > 0 ? r10(proposed!) : r10(quoteRm * 0.93);
  return Math.min(quoteRm, Math.max(r10(quoteRm * 0.88), ask));
}

/** The order cannot be planned without these; the agent asks the customer instead of guessing. */
export function blockersOf(o: Order): string[] {
  const b: string[] = [];
  if (!o.pallets) b.push('pallet count');
  if (!DIST[o.destination]) b.push('delivery city');
  return b;
}

/** Coerces any model or fallback output into a clean Order and records what is missing. */
export function normalizeOrder(raw: Partial<Record<keyof Order, unknown>>, fallbackCustomer: string): Order {
  const temp = String(raw.temp ?? '');
  const o: Order = {
    customer: String(raw.customer || fallbackCustomer || 'Unknown customer'),
    contact: String(raw.contact || ''),
    destination: city(String(raw.destination ?? '')) || String(raw.destination || '').trim() || 'Unknown',
    pallets: Math.max(0, Math.round(Number(raw.pallets) || 0)),
    commodity: String(raw.commodity || 'General cargo'),
    temp: /frozen/i.test(temp) ? 'frozen' : /chill|reefer|cold/i.test(temp) ? 'chilled' : 'ambient',
    equipment: Array.isArray(raw.equipment) ? raw.equipment.map(String) : [],
    deliverBy: String(raw.deliverBy || 'Not stated'),
    budgetRm: Number(raw.budgetRm) || null,
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : []
  };
  const has = (re: RegExp) => o.missing.some(m => re.test(m));
  if (!o.pallets && !has(/pallet/i)) o.missing.push('Pallet count');
  if (!DIST[o.destination] && !has(/destination|city/i)) o.missing.push('Delivery city');
  if (/not stated/i.test(o.deliverBy) && !has(/date|deadline|time/i)) o.missing.push('Delivery date');
  return o;
}
