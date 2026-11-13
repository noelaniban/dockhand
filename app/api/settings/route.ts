import { act } from '@/lib/http';
import { setAutonomy } from '@/lib/orchestrator/machine';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { autonomy } = (await req.json().catch(() => ({}))) as { autonomy?: string };
  return act(() => {
    if (autonomy !== 'approve' && autonomy !== 'auto') throw new Error('Autonomy must be "approve" or "auto".');
    setAutonomy(autonomy);
  });
}
