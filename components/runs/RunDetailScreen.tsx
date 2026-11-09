'use client';

import { RunActions } from './RunActions';
import { RunEventLog } from './RunEventLog';
import { RunFlightPath } from './RunFlightPath';
import { RunOutput } from './RunOutput';
import { PageHead } from '@/components/ui/PageHead';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import { formatDuration, formatTokens, relativeTime } from '@/lib/format';
import { formatBytes, type FlightEvent } from '@/lib/home-util';
import { formatUsd, headTitle, lastErrorText, LIVE, type AgentChip } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';

type Props = {
  run: Run;
  events: FlightEvent[];
  agents: AgentChip[];
  now: Date;
};

function resultPlaceholder(status: Run['status']): string {
  switch (status) {
    case 'queued':
    case 'running':
      return 'The merged result appears here when the flight lands.';
    case 'failed':
      return 'This run failed before a result was merged.';
    case 'cancelled':
      return 'This run was cancelled before a result was merged.';
    default:
      return 'No result was recorded for this run.';
  }
}

/**
 * One flight in full (spec §3.4): the head facts, its path, the streaming log, the merged result
 * with the files produced, and the input it started from.
 */
export function RunDetailScreen({ run, events, agents, now }: Props) {
  const agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const failure = run.status === 'failed' ? lastErrorText(events) : null;

  return (
    <>
      <PageHead
        eyebrow="Flight"
        title={headTitle(run.input.text)}
        meta={
          <>
            <StatusPill variant={runStatusVariant(run.status)} />
            <span>{run.displayId}</span>
            {run.durationMs !== null ? <span>took {formatDuration(run.durationMs)}</span> : null}
            <span>{formatTokens(tokens)} tokens</span>
            {run.usage.costUsd > 0 ? <span>{formatUsd(run.usage.costUsd)}</span> : null}
            {run.startedAt ? <span>started {relativeTime(run.startedAt, now)}</span> : null}
          </>
        }
        actions={<RunActions run={run} />}
      />
      <div className="flex flex-col gap-7 wide:grid wide:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] wide:items-start">
        <section
          aria-labelledby="path-title"
          className="flex min-w-0 flex-col gap-4 card p-6 wide:col-start-2 wide:row-start-1"
        >
          <h2 id="path-title" className="text-display-sm text-ink-strong">
            Flight path
          </h2>
          <RunFlightPath
            plan={run.plan}
            agents={agents}
            now={now}
            emptyMessage={
              LIVE.has(run.status) ? 'The plan is being drawn up.' : 'No steps were planned.'
            }
          />
        </section>
        <div className="flex min-w-0 flex-col gap-7 wide:col-start-1 wide:row-start-1">
          <RunEventLog run={run} initialEvents={events} agentNames={agentNames} />
          <section aria-labelledby="result-title" className="flex min-w-0 flex-col gap-4 card p-6">
            <h2 id="result-title" className="text-display-sm text-ink-strong">
              Result
            </h2>
            {run.output ? (
              <RunOutput markdown={run.output.markdown} />
            ) : (
              <p className="max-w-[34rem] text-body-sm text-body">
                {resultPlaceholder(run.status)}
                {failure ? (
                  <>
                    {' '}
                    <span className="text-danger">{failure}</span>
                  </>
                ) : null}
              </p>
            )}
            {run.output && run.output.artifacts.length > 0 ? (
              <ul
                aria-label="Files produced"
                className="flex flex-col gap-1.5 border-t border-hairline pt-4"
              >
                {run.output.artifacts.map((a) => (
                  <li key={a.blobUrl} className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                    <span className="font-mono text-code text-code-ink">{a.name}</span>
                    <span className="truncate font-mono text-caption text-mute select-all">
                      {a.blobUrl}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <section aria-labelledby="input-title" className="flex min-w-0 flex-col gap-3 card p-6">
            <h2 id="input-title" className="text-display-sm text-ink-strong">
              Input
            </h2>
            <p className="text-body-md [overflow-wrap:anywhere] whitespace-pre-wrap text-body">
              {run.input.text}
            </p>
            {run.input.attachments.length > 0 ? (
              <ul aria-label="Attachments" className="flex flex-wrap gap-2">
                {run.input.attachments.map((a) => (
                  <li
                    key={a.blobUrl}
                    className="inline-flex max-w-full items-center gap-2 rounded-pill border border-hairline bg-canvas py-1 pr-3 pl-3 text-body-sm text-ink"
                  >
                    <span className="truncate font-mono text-code">{a.name}</span>
                    <span className="shrink-0 text-caption text-mute">{formatBytes(a.size)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
