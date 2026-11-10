import { Badge, type BadgeTone } from '@/components/arc/badge/badge';
import type { RunStatus } from '@/lib/schemas';

/** Every status a pill can show: runs, agents, tools and memory entries. */
export type StatusVariant =
  | 'running'
  | 'waiting'
  | 'idle'
  | 'paused'
  | 'done'
  | 'failed'
  | 'needs-auth'
  | 'connected'
  | 'stale'
  | 'conflict'
  | 'expired'
  | 'queued'
  | 'cancelled';

/** Status means status: cyan is alive, emerald done, amber needs you, red failed; the rest neutral. */
const TONE: Record<StatusVariant, BadgeTone> = {
  running: 'info',
  connected: 'info',
  waiting: 'neutral',
  idle: 'neutral',
  paused: 'neutral',
  queued: 'neutral',
  cancelled: 'neutral',
  expired: 'neutral',
  done: 'success',
  failed: 'danger',
  conflict: 'danger',
  'needs-auth': 'warning',
  stale: 'warning',
};

/** Status labels are precise words, never the metaphor: a run is "running", not "flying". */
export function StatusPill({
  variant,
  label = variant,
  className,
}: {
  variant: StatusVariant;
  label?: string;
  className?: string;
}) {
  return (
    <Badge tone={TONE[variant]} dot pill className={className}>
      {label}
    </Badge>
  );
}

export function runStatusVariant(status: RunStatus): StatusVariant {
  return status;
}
