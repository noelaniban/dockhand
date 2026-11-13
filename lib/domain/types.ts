export type Temp = 'ambient' | 'chilled' | 'frozen';
export type Autonomy = 'approve' | 'auto';
export type Actor = 'Intake' | 'Dispatch' | 'Carrier' | 'You' | 'System';
export type Source = 'model' | 'scripted' | 'seeded';

export interface Email {
  id: string;
  from: string;
  company: string;
  subject: string;
  receivedAt: string; // HH:MM, local DC time
  body: string;
  test?: boolean;
}

/** A transport order as the intake agent extracted it. Missing values stay missing. */
export interface Order {
  customer: string;
  contact: string;
  destination: string;
  pallets: number;
  commodity: string;
  temp: Temp;
  equipment: string[];
  deliverBy: string;
  budgetRm: number | null;
  missing: string[];
}

export interface Load {
  id: string;
  dest: string;
  pallets: number;
  temp: Temp;
  pickup: string;
  carrier: string;
  rateRm: number | null;
  status: 'Planned' | 'Booked';
}

export interface Slot {
  dock: string;
  window: string;
  day: number; // day of month, Nov 2026
  hour: number;
}

export interface Carrier {
  name: string;
  ratePerKm: number;
  onTimePct: number;
  equipment: string[];
  permit: string;
  permitValid: boolean;
}

export interface Plan {
  consolidate: boolean;
  loadId: string;
  onTruck: number;
  total: number;
  truck: string;
  dock: string;
  window: string;
  rationale: string;
}

export interface Quote {
  carrier: string;
  quoteRm: number;
  onTimePct: number;
  equipment: string[];
}

export interface Deal {
  quotes: Quote[];
  excluded: string[];
  pick: string;
  quoteRm: number;
  counterRm: number;
  finalRm: number;
  benchmarkRm: number;
  withinBenchmark: boolean;
  reason: string;
  message: string;
  reply: string;
}

export interface Booking {
  loadId: string;
  confirmation: string;
}

export interface ToolCall {
  tool: string;
  input: unknown;
  output: unknown;
}

export type StepKey = 'intake' | 'dispatch' | 'carrier' | 'booking';
export type StepStatus = 'running' | 'review' | 'approved' | 'blocked' | 'done';

export interface Step<T> {
  status: StepStatus;
  data?: T;
  by?: 'you' | 'agent';
  at?: string;
  source?: Source;
  calls: ToolCall[];
  notes: string[];
}

export interface Run {
  intake?: Step<Order>;
  dispatch?: Step<Plan>;
  carrier?: Step<Deal>;
  booking?: Step<Booking>;
  reply?: string; // clarification drafted when the order cannot be planned
}

export interface LogEntry {
  at: string;
  actor: Actor;
  text: string;
}
