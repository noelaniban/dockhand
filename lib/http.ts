import { NextResponse } from 'next/server';
import { snapshot } from './orchestrator/snapshot';

/** Runs an action and answers with the fresh snapshot, or a 409 with a plain-language reason. */
export async function act(fn: () => unknown | Promise<unknown>, extra: Record<string, unknown> = {}) {
  try {
    const out = await fn();
    return NextResponse.json({ ok: true, ...(out && typeof out === 'object' ? out : {}), ...extra, snapshot: snapshot() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, snapshot: snapshot() }, { status: 409 });
  }
}
