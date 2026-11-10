import Link from 'next/link';
import { clsx } from 'clsx';
import { ButtonLink } from '@/components/ui/Button';
import { shortWhen } from '@/lib/format';
import type { RecentRun } from '@/lib/home';
import type { RunStatus } from '@/lib/schemas';

const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'text-cyan',
  done: 'text-emerald',
  failed: 'text-danger',
  queued: 'text-mute',
  cancelled: 'text-mute',
};

/** The newest flights as small cards: id, task and status. Each opens its log. */
export function RunMiniCards({
  runs,
  now,
  className,
}: {
  runs: RecentRun[];
  now: Date;
  className?: string;
}) {
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
          {runs.map((r) => (
            <li key={r.id} className="flex min-w-0">
              <Link
                href={`/runs/${r.displayId}`}
                className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-hairline bg-canvas-raised p-3 transition-colors hover:bg-canvas-muted"
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
                <span className="truncate text-body-sm text-ink">{r.title}</span>
                <span className="font-mono text-caption text-mute">
                  {shortWhen(r.startedAt ?? r.createdAt, now)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
