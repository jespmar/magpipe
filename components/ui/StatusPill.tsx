import { clsx } from 'clsx';
import type { RunStatus } from '@/lib/schemas';

/** Spec §5: running (cyan), waiting (white), idle (mute), done (emerald), failed (red), needs-auth (amber). */
export type StatusVariant =
  | 'running'
  | 'waiting'
  | 'idle'
  | 'paused'
  | 'done'
  | 'failed'
  | 'needs-auth'
  | 'queued'
  | 'cancelled';

const STYLE: Record<StatusVariant, string> = {
  running: 'border-cyan/45 text-cyan',
  waiting: 'border-hairline text-ink',
  idle: 'border-hairline text-mute',
  paused: 'border-hairline text-mute',
  done: 'border-emerald/45 text-emerald',
  failed: 'border-danger/45 text-danger',
  'needs-auth': 'border-warn/45 text-warn',
  queued: 'border-hairline text-mute',
  cancelled: 'border-hairline text-mute',
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
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 font-sans text-caption font-medium whitespace-nowrap',
        STYLE[variant],
        className,
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'size-1.5 rounded-pill bg-current',
          variant === 'running' && 'motion-safe:animate-blink',
        )}
      />
      {label}
    </span>
  );
}

export function runStatusVariant(status: RunStatus): StatusVariant {
  return status;
}
