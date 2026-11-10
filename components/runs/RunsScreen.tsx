'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ButtonLink } from '@/components/ui/Button';
import { DemoLink } from '@/components/ui/DemoLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterControl } from '@/components/ui/FilterControl';
import { PageHead } from '@/components/ui/PageHead';
import { SearchInput } from '@/components/ui/SearchInput';
import { RunActions } from './RunActions';
import { RunFlightPath } from './RunFlightPath';
import { RunTable } from './RunTable';
import { StatStrip } from './StatStrip';
import {
  LIVE,
  matchesRunFilter,
  matchesRunQuery,
  RUN_FILTERS,
  type AgentChip,
  type RunFilter,
  type RunsStats,
} from '@/lib/runs-util';
import type { Run, RunStatus } from '@/lib/schemas';
import { useLiveRefresh } from '@/lib/use-run-events';

type Props = {
  runs: Run[];
  counts: Record<RunStatus | 'all', number>;
  agents: AgentChip[];
  stats: RunsStats;
  fresh: boolean;
  /** From `?run=<displayId>`: the flight to land on. */
  initialId?: string;
  now: Date;
};

const DESCRIPTION =
  'Every task Magpipe has sent the flock out on: who flew, how long it took, what it cost.';

/** The Runs screen (spec §3.4): head, stats strip, filter pills, the ledger and the selected flight. */
export function RunsScreen({ runs, counts, agents, stats, fresh, initialId, now }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => runs.find((r) => r.displayId === initialId)?.id ?? runs[0]?.id ?? null,
  );

  // A search narrows the pill counts with it; without one the server's whole-ledger counts stand.
  const queried = useMemo(
    () => (query.trim() ? runs.filter((r) => matchesRunQuery(r, query, agents)) : null),
    [runs, query, agents],
  );
  const pillCounts = useMemo(() => {
    if (!queried) return counts;
    const next = Object.fromEntries(RUN_FILTERS.map((f) => [f.key, 0])) as Record<
      RunFilter,
      number
    >;
    for (const r of queried) {
      next.all += 1;
      if (r.status in next) next[r.status as RunFilter] += 1;
    }
    return next;
  }, [queried, counts]);
  const visible = useMemo(
    () => (queried ?? runs).filter((r) => matchesRunFilter(r.status, filter)),
    [queried, runs, filter],
  );

  // Picking a row brings the flight's card into view when it sits below the fold.
  const card = useRef<HTMLElement>(null);
  const [picks, setPicks] = useState(0);
  useEffect(() => {
    if (picks > 0) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [picks]);
  // Keep the selection valid as the list narrows: fall back to the first visible flight.
  const selected = runs.find((r) => r.id === selectedId) ?? null;
  const shown =
    selected && visible.some((r) => r.id === selected.id) ? selected : (visible[0] ?? null);

  // While any flight is live, its events keep this screen's server data current.
  const liveRun = runs.find((r) => LIVE.has(r.status)) ?? null;
  useLiveRefresh(liveRun?.id ?? null, liveRun !== null);

  const head = (
    <PageHead
      title="Runs"
      description={DESCRIPTION}
      actions={
        <>
          <SearchInput
            label="Search runs"
            placeholder="Search runs, agents…"
            value={query}
            onChange={setQuery}
          />
          <ButtonLink href="/" variant="primary">
            New run
          </ButtonLink>
        </>
      }
    />
  );

  if (runs.length === 0) {
    return (
      <>
        {head}
        <EmptyState
          title="No flights yet"
          description="A flight is one task handed to Magpipe, from plan to merged result. Start one from the prompt on the home screen."
          actions={fresh ? <DemoLink /> : undefined}
        />
      </>
    );
  }

  return (
    <>
      {head}
      <StatStrip stats={stats} />
      <FilterControl
        label="Filter runs"
        options={RUN_FILTERS.map((f) => ({
          key: f.key,
          label: f.label,
          count: pillCounts[f.key],
        }))}
        value={filter}
        onChange={setFilter}
      />
      <div className="flex flex-col gap-7 wide:flex-row wide:items-start">
        <RunTable
          runs={visible}
          agents={agents}
          selectedId={shown?.id ?? null}
          onSelect={(id) => {
            setSelectedId(id);
            setPicks((n) => n + 1);
          }}
          emptyMessage={
            query.trim() ? `No runs match “${query.trim()}”.` : 'No runs with this status.'
          }
          now={now}
          className="wide:flex-[1_1_1200px]"
        />
        {shown ? (
          <SelectedRun
            ref={card}
            run={shown}
            agents={agents}
            now={now}
            className="wide:flex-[0_1_640px]"
          />
        ) : null}
      </div>
    </>
  );
}

/** The selected flight: id, task, Open log · Re-fly (· Cancel while live) and its path. */
function SelectedRun({
  ref,
  run,
  agents,
  now,
  className,
}: {
  ref: React.Ref<HTMLElement>;
  run: Run;
  agents: AgentChip[];
  now: Date;
  className?: string;
}) {
  return (
    <section
      ref={ref}
      aria-labelledby="selected-run-title"
      className={clsx('flex min-w-0 flex-col gap-4 card p-5', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-code text-mute">{run.displayId}</span>
          <h2 id="selected-run-title" className="line-clamp-2 text-display-sm text-ink-strong">
            {run.input.text}
          </h2>
        </div>
        <RunActions run={run} size="sm" showOpen />
      </div>
      <RunFlightPath
        plan={run.plan}
        agents={agents}
        now={now}
        emptyMessage={
          LIVE.has(run.status) ? 'The plan is being drawn up.' : 'No steps were planned.'
        }
      />
    </section>
  );
}
