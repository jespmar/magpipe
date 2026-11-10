'use client';

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Avatar } from '@/components/ui/Avatar';
import { formatDuration, formatTokens, shortWhen } from '@/lib/format';
import { runAgentIds, type AgentChip } from '@/lib/runs-util';
import type { Run, RunStatus } from '@/lib/schemas';

type Props = {
  runs: Run[];
  agents: AgentChip[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyMessage: string;
  now: Date;
  className?: string;
};

const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'text-cyan',
  done: 'text-emerald',
  failed: 'text-danger',
  queued: 'text-mute',
  cancelled: 'text-mute',
};

/**
 * The flight ledger (spec §3.4): flight · task · agents · status · duration · tokens · started.
 * Twelve columns on a 900 px floor, so narrow windows scroll the table inside its card instead
 * of folding its facts.
 */
export function RunTable({
  runs,
  agents,
  selectedId,
  onSelect,
  emptyMessage,
  now,
  className,
}: Props) {
  // A clipped ledger says so: a fade over its last line, only while there is more to scroll to.
  const box = useRef<HTMLElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () =>
      setClipped(
        el.scrollHeight > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      );
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [runs.length]);

  return (
    <section
      ref={box}
      aria-label="Runs"
      className={clsx(
        // `relative` keeps the rows' visually hidden labels inside this scroll box; otherwise
        // they position against the document and widen the page on narrow screens. Below 1600 px
        // the ledger scrolls inside its own height so the selected flight stays within reach.
        'relative max-h-[28rem] min-w-0 overflow-auto card wide:max-h-none',
        className,
      )}
    >
      {runs.length === 0 ? (
        <p className="px-5 py-8 text-body-sm text-body">{emptyMessage}</p>
      ) : (
        <div className="min-w-[900px]">
          <div className="sticky top-0 z-10 grid grid-cols-12 gap-3 border-b border-hairline-soft bg-canvas-raised px-5 py-3 text-caption font-medium text-mute">
            <span className="col-span-2">Flight</span>
            <span className="col-span-4">Task</span>
            <span className="col-span-2">Agents</span>
            <span>Status</span>
            <span className="text-right">Duration</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Started</span>
          </div>
          <ul>
            {runs.map((r) => {
              const on = r.id === selectedId;
              const birds = runAgentIds(r)
                .map((id) => agents.find((a) => a.id === id))
                .filter((a): a is AgentChip => a !== undefined);
              const tokens = r.usage.inputTokens + r.usage.outputTokens;
              return (
                <li key={r.id} className="group">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onSelect(r.id)}
                    className={clsx(
                      'grid w-full grid-cols-12 items-center gap-3 border-b border-l-2 border-b-hairline-soft px-5 py-3 text-left transition-colors group-last:border-b-0 hover:bg-canvas-muted focus-visible:-outline-offset-3',
                      on ? 'border-l-cyan bg-cyan-soft' : 'border-l-transparent',
                    )}
                  >
                    <span className="col-span-2 truncate font-mono text-code text-ink">
                      {r.displayId}
                    </span>
                    <span className="col-span-4 truncate text-body-sm text-ink">
                      {r.input.text}
                    </span>
                    <span className="col-span-2 flex items-center gap-1">
                      {birds.length === 0 ? (
                        <span className="font-mono text-caption text-mute">—</span>
                      ) : (
                        birds.slice(0, 4).map((a) => (
                          <span key={a.id} className="inline-flex">
                            <Avatar initials={a.initials} size={24} />
                            <span className="sr-only">{a.name}</span>
                          </span>
                        ))
                      )}
                      {birds.length > 4 ? (
                        <span className="font-mono text-caption text-mute">
                          +{birds.length - 4}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1.5 text-caption font-medium',
                        STATUS_COLOR[r.status],
                      )}
                    >
                      <span
                        aria-hidden
                        className={clsx(
                          'size-1.5 shrink-0 rounded-pill bg-current',
                          r.status === 'running' && 'motion-safe:animate-blink',
                        )}
                      />
                      {r.status}
                    </span>
                    <span className="text-right font-mono text-code text-body tabular-nums">
                      {r.durationMs !== null ? formatDuration(r.durationMs) : '—'}
                    </span>
                    <span className="text-right font-mono text-code text-body tabular-nums">
                      {tokens > 0 ? formatTokens(tokens) : '—'}
                    </span>
                    <span className="text-right font-mono text-code text-mute">
                      {shortWhen(r.startedAt ?? r.createdAt, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {clipped ? (
            <div
              aria-hidden
              className="pointer-events-none sticky bottom-0 -mt-6 h-6 bg-gradient-to-t from-canvas-raised to-transparent wide:hidden"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
