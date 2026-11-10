'use client';

import { clsx } from 'clsx';
import { RunActions } from '@/components/runs/RunActions';
import { RunEventLog } from '@/components/runs/RunEventLog';
import { RunOutput } from '@/components/runs/RunOutput';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import { Streaming } from '@/components/ui/Streaming';
import { formatDuration, formatTokens } from '@/lib/format';
import { formatBytes, type FlightEvent } from '@/lib/home-util';
import { formatUsd, LIVE, resultPlaceholder } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';

type Props = {
  run: Run;
  /** The conversation this run continues, oldest first, the run itself last. */
  thread: Run[];
  initialEvents: FlightEvent[];
  agentNames: Record<string, string>;
  onSelect: (run: Run) => void;
  onRefly: (run: Run) => void;
  className?: string;
};

/**
 * The selected flight beside the nest: what was asked (and the turns before it), the merged
 * result, and the trail, streaming while the flight is up. "Open log" is the full page.
 */
export function RunPanel({
  run,
  thread,
  initialEvents,
  agentNames,
  onSelect,
  onRefly,
  className,
}: Props) {
  const live = LIVE.has(run.status);
  const earlier = thread.slice(0, -1);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const facts = [
    run.durationMs !== null ? formatDuration(run.durationMs) : null,
    tokens > 0 ? `${formatTokens(tokens)} tokens` : null,
    run.usage.costUsd > 0 ? formatUsd(run.usage.costUsd) : null,
  ].filter((f): f is string => f !== null);

  return (
    <section aria-label={run.displayId} className={clsx('flex min-w-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="font-mono text-code text-ink">{run.displayId}</span>
          {live ? <Streaming /> : <StatusPill variant={runStatusVariant(run.status)} />}
          {facts.length > 0 ? (
            <span className="font-mono text-caption text-mute">{facts.join(' · ')}</span>
          ) : null}
        </div>
        <RunActions run={run} size="sm" showOpen onRefly={onRefly} />
      </div>
      <div className="flex min-w-0 flex-col gap-4 card p-4">
        {earlier.length > 0 ? (
          <ol
            aria-label="Earlier in this thread"
            className="flex flex-col gap-1.5 border-b border-hairline-soft pb-4"
          >
            {earlier.map((turn) => (
              <li key={turn.id} className="flex min-w-0">
                <button
                  type="button"
                  onClick={() => onSelect(turn)}
                  className="flex min-w-0 flex-1 items-baseline gap-3 rounded-xs text-left text-body transition-colors hover:text-ink-strong"
                >
                  <span className="shrink-0 font-mono text-caption text-mute">
                    {turn.displayId}
                  </span>
                  <span className="truncate text-body-sm">{turn.input.text}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex flex-col gap-3">
          <p className="max-w-[34rem] text-body-md [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
            {run.input.text}
          </p>
          {run.input.attachments.length > 0 ? (
            <ul aria-label="Attachments" className="flex flex-wrap gap-2">
              {run.input.attachments.map((a) => (
                <li
                  key={a.blobUrl}
                  className="inline-flex max-w-full items-center gap-2 rounded-pill border border-hairline bg-canvas px-3 py-1 text-body-sm text-ink"
                >
                  <span className="truncate font-mono text-code">{a.name}</span>
                  <span className="shrink-0 text-caption text-mute">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <section
          aria-labelledby="home-result-title"
          className="flex min-w-0 flex-col gap-3 border-t border-hairline-soft pt-4"
        >
          <h2 id="home-result-title" className="text-body-sm font-medium text-ink-strong">
            Result
          </h2>
          {run.output ? (
            <RunOutput markdown={run.output.markdown} />
          ) : (
            <p className="max-w-[34rem] text-body-sm text-body">{resultPlaceholder(run.status)}</p>
          )}
          {run.output && run.output.artifacts.length > 0 ? (
            <ul aria-label="Files produced" className="flex flex-col gap-1.5">
              {run.output.artifacts.map((a) => (
                <li key={a.blobUrl} className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-code text-ink">{a.name}</span>
                  <span className="truncate font-mono text-caption text-mute select-all">
                    {a.blobUrl}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <RunEventLog
          run={run}
          initialEvents={initialEvents}
          agentNames={agentNames}
          replay
          frame="plain"
          className="border-t border-hairline-soft pt-4"
        />
      </div>
    </section>
  );
}
