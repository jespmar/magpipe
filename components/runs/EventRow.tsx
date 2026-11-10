import { clsx } from 'clsx';
import { clockTime, type FlightEvent } from '@/lib/home-util';

/** One line of a flight log: `time · agent · text`; the orchestrator in cyan, errors in red. */
export function EventRow({ event }: { event: FlightEvent }) {
  return (
    <li className="flex items-start gap-4 border-b border-hairline-soft py-2.5 last:border-b-0">
      <time
        dateTime={event.ts}
        className="w-16 shrink-0 font-mono text-code text-mute tabular-nums"
      >
        {clockTime(new Date(event.ts))}
      </time>
      <span
        className={clsx(
          'w-24 shrink-0 truncate font-mono text-code font-medium',
          event.agentId === null ? 'text-cyan' : 'text-ink-strong',
        )}
      >
        {event.agent}
      </span>
      <span
        className={clsx(
          'min-w-0 flex-1 text-body-sm [overflow-wrap:anywhere]',
          event.kind === 'error' ? 'text-danger' : 'text-body',
        )}
      >
        {event.text}
      </span>
    </li>
  );
}
