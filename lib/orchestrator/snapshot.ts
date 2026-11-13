import { MODELS, modelEnabled } from '../agents/llm';
import { CARRIERS, EXAMPLES } from '../tools/data';
import { requestState } from './machine';
import { db } from './store';

/** Everything the control tower renders, in one JSON payload. */
export function snapshot() {
  const s = db();
  return {
    mode: modelEnabled() ? ('model' as const) : ('scripted' as const),
    models: { fast: MODELS.fast, smart: MODELS.smart },
    autonomy: s.autonomy,
    requests: s.emails.map(e => ({ email: e, run: s.runs[e.id] ?? {}, state: requestState(s.runs[e.id]), bookedInMs: s.bookedIn[e.id] ?? null })),
    loads: s.loads,
    carriers: CARRIERS,
    log: s.log,
    examples: EXAMPLES
  };
}

export type Snapshot = ReturnType<typeof snapshot>;
