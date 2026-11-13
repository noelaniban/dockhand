import { act } from '@/lib/http';
import { resetStore } from '@/lib/orchestrator/store';

export const dynamic = 'force-dynamic';
export const POST = () => act(() => resetStore());
