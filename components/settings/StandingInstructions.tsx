import Link from 'next/link';
import { ButtonLink } from '@/components/ui/Button';
import { clipValue, STANDING_NS, standingReach } from '@/lib/memory-util';
import type { MemoryEntry } from '@/lib/schemas';

const MEMORY_HREF = `/memory?ns=${STANDING_NS}`;

/**
 * The operator's standing instructions (D34): every `decisions` entry, which the orchestrator
 * reads before every plan. Read here, written in Memory. `null` when the database cannot be read.
 */
export function StandingInstructions({ entries }: { entries: MemoryEntry[] | null }) {
  return (
    <section aria-labelledby="standing-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-[52px] items-center justify-between gap-3">
        <h3 id="standing-title" className="text-body-sm font-medium text-ink">
          Standing instructions
        </h3>
        {entries && entries.length > 0 ? (
          <ButtonLink href={MEMORY_HREF} size="sm">
            Edit in Memory
          </ButtonLink>
        ) : null}
      </div>
      {entries === null ? (
        <p className="text-body-sm text-body">
          Standing instructions can’t be read right now. The notice at the top of the page says why.
        </p>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-body-sm text-body">
            None yet. A decision you write in Memory reaches every plan from the next flight on, so
            begin it with when it applies, for example “For code changes:”.
          </p>
          <ButtonLink href={`${MEMORY_HREF}&new=1`} size="sm">
            Add a decision
          </ButtonLink>
        </div>
      ) : (
        <>
          <p className="text-body-sm text-body">{standingReach(entries.length)}</p>
          <ul aria-label="Decisions" className="flex flex-col border-t border-hairline-soft">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex min-w-0 flex-col gap-1 border-b border-hairline-soft py-3"
              >
                <Link
                  href={`${MEMORY_HREF}&id=${e.id}`}
                  className="self-start font-mono text-code break-all text-ink underline-offset-4 hover:underline"
                >
                  {e.key}
                </Link>
                <p className="text-body-sm text-body">{clipValue(e.value)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
