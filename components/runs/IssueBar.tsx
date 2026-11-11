'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/arc/badge/badge';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { clockTime } from '@/lib/home-util';
import type { IssueStage, Run, RunStatus, TrackerIssue } from '@/lib/schemas';
import { PIPELINE_LABELS } from '@/lib/tracker/labels';

type Props = {
  run: Pick<Run, 'id' | 'status' | 'input'>;
  /** The run page's one primary action; secondary where the surface has its own (Home's Run). */
  emphasis?: 'primary' | 'secondary';
  className?: string;
};

/** Issue dates arrive as JSON strings. */
type IssueJson = Omit<TrackerIssue, 'approvedAt' | 'createdAt' | 'updatedAt'> & {
  approvedAt: string | null;
};
type GoalsRun = { id: string; displayId: string; status: RunStatus };
type Answer = { issue: IssueJson | null; goals: IssueJson[]; goalsRun: GoalsRun | null };

const stageTone = (stage: IssueStage) =>
  stage === 'spec_ready' || stage === 'needs_you'
    ? 'warning'
    : stage === 'done'
      ? 'success'
      : 'neutral';

function stageText(issue: Pick<IssueJson, 'stage' | 'stateName'>): string {
  return issue.stage === 'other' ? issue.stateName : PIPELINE_LABELS[issue.stage].toLowerCase();
}

function IssueLink({ issue }: { issue: Pick<IssueJson, 'url' | 'identifier'> }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-code text-ink hover:text-ink-strong"
    >
      {issue.identifier}
      <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
      <span className="sr-only">(opens Linear)</span>
    </a>
  );
}

/**
 * The Linear issue a factory run concerns (D38 to D40): the spec a spec run filed, with gate G1's
 * Magpipe door; the spec a goals run splits, with the goals filed under it; or the goal a build
 * run builds. A spec run also links the goals run its approval started. Approve sets the approved status in Linear, so Linear holds the one answer.
 * Nothing shows for a run with no issue.
 */
export function IssueBar({ run, emphasis = 'primary', className }: Props) {
  const [data, setData] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const template = run.input.template;
  const relevant =
    (template === 'spec' && run.status === 'done') ||
    ((template === 'goals' || template === 'build') && !!run.input.issueId);

  useEffect(() => {
    if (!relevant) return;
    let live = true;
    api<Answer>(`/api/runs/${run.id}/issue`)
      .then((answer) => live && setData(answer))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
    // The run's status is a dependency so a goals run shows its goals once they are filed.
  }, [run.id, relevant, run.status]);

  const issue = data?.issue;
  if (!relevant || !issue) return null;

  async function approve() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await api<{
        issue: IssueJson;
        goalsRun: { id: string; displayId: string } | null;
        goalsProblem: string | null;
      }>(`/api/issues/${issue!.id}/approve`, { method: 'POST', body: '{}' });
      setData((d) => ({
        issue: res.issue,
        goals: d?.goals ?? [],
        goalsRun: res.goalsRun ? { ...res.goalsRun, status: 'queued' } : (d?.goalsRun ?? null),
      }));
      if (res.goalsProblem) {
        setNote(
          `The goals did not start: ${res.goalsProblem} The watcher tries again at its next check.`,
        );
      }
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Linear could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const waiting = template === 'spec' && issue.stage === 'spec_ready';
  const approved = issue.approvedAt
    ? `Approved ${issue.approvedVia === 'magpipe' ? 'in Magpipe' : 'in Linear'} at ${clockTime(new Date(issue.approvedAt))}.`
    : null;
  const caption = waiting
    ? 'Waiting for you: approve it here, or move it to the approved status in Linear.'
    : issue.stage === 'needs_you'
      ? `Needs you: the findings are on the issue. Move it back to ${PIPELINE_LABELS.approved.toLowerCase()} in Linear to try again.`
      : issue.stage === 'merge_question'
        ? `Ready to merge: the issue names the branch. Merge it, then move the issue to ${PIPELINE_LABELS.done.toLowerCase()} in Linear.`
        : (approved ?? `Linear status: ${issue.stateName}.`);

  return (
    <section aria-label="Linear issue" className={clsx('flex flex-col gap-3 card p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <IssueLink issue={issue} />
          <Badge tone={stageTone(issue.stage)}>{stageText(issue)}</Badge>
        </div>
        {waiting ? (
          <Button variant={emphasis} size="sm" loading={busy} onClick={approve}>
            Approve the spec
          </Button>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-body-sm text-ink">{issue.title}</p>
      <p className="text-caption text-mute">{caption}</p>
      {data.goalsRun ? (
        <p className="text-body-sm text-body">
          Goals: split in{' '}
          <Link
            href={`/runs/${data.goalsRun.displayId}`}
            className="font-mono text-code text-ink underline-offset-4 hover:underline"
          >
            {data.goalsRun.displayId}
          </Link>
          <span className="text-mute"> · {data.goalsRun.status}</span>
        </p>
      ) : null}
      {data.goals.length > 0 ? (
        <ul aria-label="Goals" className="flex flex-col gap-2 border-t border-hairline-soft pt-3">
          {data.goals.map((g) => (
            <li key={g.id} className="flex min-w-0 items-center gap-3">
              <IssueLink issue={g} />
              <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{g.title}</span>
              <Badge tone={stageTone(g.stage)}>{stageText(g)}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="text-caption text-mute">{note}</p> : null}
      {problem ? (
        <p role="alert" className="text-body-sm text-danger">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
