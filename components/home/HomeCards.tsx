'use client';

import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { shortWhen } from '@/lib/format';
import { LIVE_RUN_STATUSES } from '@/lib/home-util';
import type { Run, RunStatus } from '@/lib/schemas';

const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'text-cyan',
  done: 'text-emerald',
  failed: 'text-danger',
  queued: 'text-mute',
  cancelled: 'text-mute',
};

type Props = {
  runs: Run[];
  selectedId: string | null;
  onSelect: (run: Run) => void;
  /** Close a landed flight's card. Live flights have no close button. */
  onClose: (run: Run) => void;
  /** Why the last close did not take, if it did not. */
  notice: string | null;
  now: Date;
  className?: string;
};

/**
 * The newest flights as small cards: id, task and status. Choosing one opens it in the panel and
 * makes it the thread the prompt continues; a landed flight's card can be closed.
 */
export function RunMiniCards({
  runs,
  selectedId,
  onSelect,
  onClose,
  notice,
  now,
  className,
}: Props) {
  return (
    <section
      aria-labelledby="home-runs-title"
      className={clsx('flex min-w-0 flex-col gap-3', className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="home-runs-title" className="text-body-sm font-medium text-ink">
          Runs
        </h2>
        <ButtonLink href="/runs" variant="ghost" size="sm">
          All flights
        </ButtonLink>
      </div>
      {runs.length === 0 ? (
        <p className="text-body-sm text-body">No flights yet. The first one lands here.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 wide:grid-cols-2">
          {runs.map((r) => {
            const selected = r.id === selectedId;
            const closable = !LIVE_RUN_STATUSES.has(r.status);
            return (
              <li key={r.id} className="relative flex min-w-0">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(r)}
                  className={clsx(
                    'flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border bg-canvas-raised p-3 pr-9 text-left transition-colors hover:bg-canvas-muted',
                    selected ? 'border-cyan' : 'border-hairline',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-caption text-mute">{r.displayId}</span>
                    <span
                      className={clsx(
                        'inline-flex shrink-0 items-center gap-1.5 text-caption font-medium',
                        STATUS_COLOR[r.status],
                      )}
                    >
                      <span
                        aria-hidden
                        className={clsx(
                          'size-1.5 rounded-pill bg-current',
                          r.status === 'running' && 'motion-safe:animate-blink',
                        )}
                      />
                      {r.status}
                    </span>
                  </span>
                  <span className="truncate text-body-sm text-ink">{r.input.text}</span>
                  <span className="font-mono text-caption text-mute">
                    {shortWhen(r.startedAt ?? r.createdAt, now)}
                  </span>
                </button>
                {closable ? (
                  <button
                    type="button"
                    aria-label={`Close ${r.displayId}`}
                    onClick={() => onClose(r)}
                    className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-pill text-mute transition-colors hover:bg-canvas-muted hover:text-ink-strong"
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {notice ? (
        <p role="status" className="text-caption text-danger">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
