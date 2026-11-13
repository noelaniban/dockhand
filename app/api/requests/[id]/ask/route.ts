import { act } from '@/lib/http';
import { askCustomer } from '@/lib/orchestrator/machine';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return act(() => askCustomer(id));
}
