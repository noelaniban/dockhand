import { act } from '@/lib/http';
import { receive } from '@/lib/orchestrator/machine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const { body } = (await req.json().catch(() => ({}))) as { body?: string };
  return act(async () => {
    const text = String(body ?? '').trim();
    if (!text) throw new Error('Write a request first.');
    if (text.length > 4000) throw new Error('Keep test requests under 4,000 characters.');
    return { id: await receive(text) };
  });
}
