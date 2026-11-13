import { act } from '@/lib/http';
import { approve } from '@/lib/orchestrator/machine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return act(() => approve(id));
}
