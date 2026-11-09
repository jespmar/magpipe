'use client';

import { clsx } from 'clsx';
import { Avatar } from '@/components/ui/Avatar';
import { StatusPill } from '@/components/ui/StatusPill';
import type { AgentRow } from '@/lib/agents';

/** The roster: a 12-column grid with the Label-style header row (spec §3.3). */
export function AgentList({
  agents,
  selectedId,
  onSelect,
  emptyMessage,
}: {
  agents: AgentRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyMessage: string;
}) {
  return (
    <section
      aria-label="Agents"
      className={clsx(
        'min-w-0 flex-[1_1_520px] overflow-hidden rounded-md border border-hairline bg-(image:--g-card) wide:flex-[1_1_760px]',
        // An empty roster keeps a roster's width instead of stretching across the vacated panel.
        agents.length === 0 && 'max-w-[46rem]',
      )}
    >
      {agents.length > 0 ? (
        <div className="hidden grid-cols-12 gap-3 border-b border-hairline bg-canvas-soft px-4 py-3 label-caps md:grid">
          <span className="col-span-5">Agent</span>
          <span className="col-span-2">Status</span>
          <span className="col-span-3">Model</span>
          <span className="col-span-2 text-right">Runs · 7d</span>
        </div>
      ) : null}
      {agents.length === 0 ? (
        <p className="px-4 py-8 text-body-sm text-body">{emptyMessage}</p>
      ) : (
        <ul>
          {agents.map((a) => {
            const on = a.id === selectedId;
            return (
              <li key={a.id} className="group">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSelect(a.id)}
                  className={clsx(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-l-2 border-b-hairline-soft px-4 py-3.5 text-left transition-colors group-last:border-b-0 hover:bg-[rgba(255,255,255,0.03)] focus-visible:-outline-offset-3 md:grid-cols-12',
                    on
                      ? 'border-l-cyan bg-[rgba(34,193,220,0.06)]'
                      : 'border-l-transparent bg-transparent',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-3 md:col-span-5">
                    <Avatar initials={a.initials} size={36} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-body-md font-semibold text-ink-strong">
                        {a.name}
                      </span>
                      <span className="truncate text-caption text-mute">{a.role}</span>
                    </span>
                  </span>
                  <span className="md:col-span-2">
                    <StatusPill variant={a.status} />
                  </span>
                  <span className="hidden truncate font-mono text-code text-body md:col-span-3 md:block">
                    {a.model}
                  </span>
                  <span className="hidden text-right font-mono text-code text-ink md:col-span-2 md:block">
                    {a.stats.runs7d}
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
