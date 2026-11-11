import { clsx } from 'clsx';
import { clockTime, type FlightEvent } from '@/lib/home-util';

/** Longer texts (a spec a step handed over, D37) open on request, so the log stays a log. */
const CLIP = 600;

/** The opening of a long text, cut at a space where one fits. */
function opening(text: string): string {
  const head = text.slice(0, CLIP);
  const cut = head.lastIndexOf(' ');
  return `${(cut > CLIP / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/**
 * One line of a flight log: `time · agent · text`; the orchestrator in cyan, errors in red. A text
 * over 600 characters shows its opening and a "Show all" disclosure.
 */
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
        {event.text.length > CLIP ? (
          <details className="group">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">{opening(event.text)} </span>
              <span className="text-caption text-mute underline-offset-4 hover:text-ink-strong hover:underline">
                <span className="group-open:hidden">Show all</span>
                <span className="hidden group-open:inline">Show less</span>
              </span>
            </summary>
            <span className="whitespace-pre-wrap">{event.text}</span>
          </details>
        ) : (
          event.text
        )}
      </span>
    </li>
  );
}
