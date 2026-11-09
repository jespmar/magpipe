'use client';

import { clsx } from 'clsx';
import { Avatar } from '@/components/ui/Avatar';
import { authorLabel, isExpired, isStale, updatedLabel, type AuthorChip } from '@/lib/memory-util';
import type { MemoryEntry } from '@/lib/schemas';

type Props = {
  entries: MemoryEntry[];
  agents: AuthorChip[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyMessage: string;
  now: Date;
};

/** The nest as a ledger: key · value · by · updated (spec §3.6). */
export function MemoryTable({ entries, agents, selectedId, onSelect, emptyMessage, now }: Props) {
  return (
    <section
      aria-label="Memories"
      className={clsx(
        'min-w-0 overflow-hidden rounded-md border border-hairline bg-(image:--g-card)',
        entries.length === 0 && 'max-w-[46rem]',
      )}
    >
      {entries.length > 0 ? (
        <div className="hidden grid-cols-12 gap-3 border-b border-hairline bg-canvas-soft px-4 py-3 label-caps md:grid">
          <span className="col-span-4">Key</span>
          <span className="col-span-5">Value</span>
          <span className="col-span-1">By</span>
          <span className="col-span-2 text-right">Updated</span>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <p className="px-4 py-8 text-body-sm text-body">{emptyMessage}</p>
      ) : (
        <ul>
          {entries.map((e) => {
            const on = e.id === selectedId;
            const flag = e.conflict
              ? 'conflict'
              : isExpired(e, now)
                ? 'expired'
                : isStale(e, now)
                  ? 'stale'
                  : null;
            const by = authorLabel(e.writtenBy, agents);
            return (
              <li key={e.id} className="group">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSelect(e.id)}
                  className={clsx(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-l-2 border-b-hairline-soft px-4 py-3 text-left transition-colors group-last:border-b-0 hover:bg-[rgba(255,255,255,0.03)] focus-visible:-outline-offset-3 md:grid-cols-12',
                    on ? 'border-l-cyan bg-[rgba(34,193,220,0.06)]' : 'border-l-transparent',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2 md:col-span-4">
                    {flag ? (
                      <span
                        className={clsx(
                          'size-1.5 shrink-0 rounded-pill',
                          flag === 'conflict'
                            ? 'bg-danger'
                            : flag === 'stale'
                              ? 'bg-warn'
                              : 'bg-mute',
                        )}
                        role="img"
                        aria-label={flag}
                      />
                    ) : null}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-code text-code-ink">{e.key}</span>
                      <span className="truncate text-caption text-body md:hidden">{e.value}</span>
                    </span>
                  </span>
                  <span className="hidden truncate text-body-sm text-body md:col-span-5 md:block">
                    {e.value}
                  </span>
                  <span className="md:col-span-1">
                    {by === 'you' ? (
                      <span className="inline-flex h-6 items-center rounded-pill border border-hairline bg-canvas-soft px-2 font-mono text-caption font-[550] text-ink-strong">
                        you
                      </span>
                    ) : (
                      <>
                        <Avatar initials={by} size={24} />
                        <span className="sr-only">{by}</span>
                      </>
                    )}
                  </span>
                  <span className="hidden text-right font-mono text-caption text-mute md:col-span-2 md:block">
                    {updatedLabel(e, now)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
