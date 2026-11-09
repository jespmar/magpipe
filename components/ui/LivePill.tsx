import { clsx } from 'clsx';
import { plural } from '@/lib/format';

/**
 * How many agents are flying right now. `null` = the database is unavailable, so the pill says
 * so instead of claiming zero.
 */
export function LivePill({ count }: { count: number | null }) {
  const unknown = count === null;
  const live = (count ?? 0) > 0;
  const full = unknown ? 'Agent status unavailable' : `${plural(count, 'agent')} active`;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-pill border border-hairline px-3 py-1 text-body-sm whitespace-nowrap text-ink"
      aria-label={full}
      title={unknown ? 'The database could not be opened' : undefined}
    >
      <span
        aria-hidden
        className={clsx(
          'size-2 rounded-pill',
          unknown ? 'bg-mute' : 'bg-accent',
          live && 'motion-safe:animate-blink',
          !live && !unknown && 'opacity-40',
        )}
      />
      {/* One element, so the flex gap does not space the words out. */}
      <span>
        {unknown ? (
          'Status unavailable'
        ) : (
          <>
            {count} <span className="hidden sm:inline">{count === 1 ? 'agent' : 'agents'} </span>
            active
          </>
        )}
      </span>
    </span>
  );
}
