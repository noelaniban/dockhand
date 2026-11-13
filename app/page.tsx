import ControlTower from '@/components/ControlTower';
import { snapshot } from '@/lib/orchestrator/snapshot';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <ControlTower initial={snapshot()} />;
}
