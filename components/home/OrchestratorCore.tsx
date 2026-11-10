import { clsx } from 'clsx';
import { DemoLink } from '@/components/ui/DemoLink';
import { formatCount, formatTokens, plural } from '@/lib/format';
import type { HomeStats } from '@/lib/runs';
import { OrchestratorOrb } from './OrchestratorOrb';

type Props = {
  stats: HomeStats;
  hasRuns: boolean;
  fresh: boolean;
  className?: string;
};

/** The nest (spec §3.2 zone 2): the orb, what Magpipe is doing, and today's three counters. */
export function OrchestratorCore({ stats, hasRuns, fresh, className }: Props) {
  const n = stats.activeAgents;
  return (
    <section
      aria-label="The nest"
      className={clsx(
        'flex flex-col items-center gap-6 border-y border-hairline-soft px-4 py-8 text-center wide:justify-center wide:border-x wide:border-y-0 wide:px-8',
        className,
      )}
    >
      <OrchestratorOrb />
      <div className="flex flex-col items-center gap-2">
        <h2 id="nest-title" className="text-display-md text-ink-strong">
          {n > 0 ? `Magpipe is flying ${plural(n, 'agent')}` : 'No agents flying right now'}
        </h2>
        <p className="max-w-[31rem] text-body-sm text-body">
          Sends each task out to the flock, collects the shiny bits they bring back and keeps the
          nest (shared memory) tidy.
        </p>
      </div>
      <dl className="flex flex-wrap justify-center gap-x-8 gap-y-3 wide:gap-x-10">
        <Counter value={formatCount(stats.runsToday)} label="runs today" />
        <Counter value={formatCount(stats.queued)} label="queued" />
        <Counter value={formatTokens(stats.tokensToday)} label="tokens used" />
      </dl>
      {!hasRuns ? (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <span className="font-mono text-code text-mute">no runs yet</span>
          {fresh ? <DemoLink variant="ghost" /> : null}
        </div>
      ) : null}
    </section>
  );
}

/** A centred mono number over its caption, the nest's version of the stat tile. */
function Counter({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse items-center gap-0.5">
      <dt className="text-caption text-mute">{label}</dt>
      <dd className="m-0 font-mono text-display-sm font-medium text-ink-strong tabular-nums wide:text-[22px] wide:leading-7">
        {value}
      </dd>
    </div>
  );
}
