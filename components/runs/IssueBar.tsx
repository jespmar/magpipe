'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/arc/badge/badge';
import { Textarea } from '@/components/arc/textarea/textarea';
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
type IssueJson = Omit<
  TrackerIssue,
  'approvedAt' | 'createdAt' | 'updatedAt' | 'mergeRequestedAt' | 'mergedAt'
> & {
  approvedAt: string | null;
  mergeRequestedAt: string | null;
  mergedAt: string | null;
};
type RunLink = { id: string; displayId: string; status: RunStatus };
type Answer = {
  issue: IssueJson | null;
  goals: IssueJson[];
  goalsRun: RunLink | null;
  landRun: RunLink | null;
};

const stageTone = (stage: IssueStage) =>
  stage === 'spec_ready' || stage === 'needs_you' || stage === 'merge_question'
    ? 'warning'
    : stage === 'done'
      ? 'success'
      : 'neutral';

function stageText(issue: Pick<IssueJson, 'stage' | 'stateName'>): string {
  return issue.stage === 'other' ? issue.stateName : PIPELINE_LABELS[issue.stage].toLowerCase();
}

function ExternalA({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1.5 font-mono text-code text-ink hover:text-ink-strong"
    >
      {children}
      <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
      <span className="sr-only">(opens in the browser)</span>
    </a>
  );
}

function RunLinkLine({ label, run }: { label: string; run: RunLink }) {
  return (
    <p className="text-body-sm text-body">
      {label}{' '}
      <Link
        href={`/runs/${run.displayId}`}
        className="font-mono text-code text-ink underline-offset-4 hover:underline"
      >
        {run.displayId}
      </Link>
      <span className="text-mute"> · {run.status}</span>
    </p>
  );
}

/**
 * The Linear issue a factory run concerns (D38 to D42): the spec a spec run filed, with gate G1's
 * Magpipe door; the spec a goals run splits, with its goals; or the goal a build or land run works
 * on, with gate G2's Magpipe door when its pull request waits for the question to merge. Each
 * door sets Linear first, so Linear holds the one answer. Nothing shows for a run with no issue.
 */
export function IssueBar({ run, emphasis = 'primary', className }: Props) {
  const [data, setData] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<'approve' | 'merge' | 'send' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const template = run.input.template;
  const relevant =
    (template === 'spec' && run.status === 'done') ||
    ((template === 'goals' || template === 'build' || template === 'land') && !!run.input.issueId);

  useEffect(() => {
    if (!relevant) return;
    let live = true;
    api<Answer>(`/api/runs/${run.id}/issue`)
      .then((answer) => live && setData(answer))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
    // The run's status is a dependency so the bar follows the run as it ends.
  }, [run.id, relevant, run.status]);

  const issue = data?.issue;
  if (!relevant || !issue) return null;

  async function act<T>(kind: 'approve' | 'merge' | 'send', fn: () => Promise<T>) {
    setBusy(kind);
    setProblem(null);
    try {
      return await fn();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Linear could not be reached. Try again.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    const res = await act('approve', () =>
      api<{
        issue: IssueJson;
        goalsRun: { id: string; displayId: string } | null;
        goalsProblem: string | null;
      }>(`/api/issues/${issue!.id}/approve`, { method: 'POST', body: '{}' }),
    );
    if (!res) return;
    setData((d) => ({
      ...d!,
      issue: res.issue,
      goalsRun: res.goalsRun ? { ...res.goalsRun, status: 'queued' } : (d?.goalsRun ?? null),
    }));
    if (res.goalsProblem) {
      setNote(
        `The goals did not start: ${res.goalsProblem} The watcher tries again at its next check.`,
      );
    }
  }

  async function merge() {
    const res = await act('merge', () =>
      api<{
        issue: IssueJson;
        landRun: { id: string; displayId: string } | null;
        landProblem: string | null;
      }>(`/api/issues/${issue!.id}/merge`, { method: 'POST', body: '{}' }),
    );
    if (!res) return;
    setData((d) => ({
      ...d!,
      issue: res.issue,
      landRun: res.landRun ? { ...res.landRun, status: 'queued' } : (d?.landRun ?? null),
    }));
    if (res.landProblem) {
      setNote(
        `The merge did not start: ${res.landProblem} The watcher tries again at its next check.`,
      );
    }
  }

  async function sendBack() {
    if (!reason.trim()) {
      setReasonError('Say what should change.');
      return;
    }
    const res = await act('send', () =>
      api<{ issue: IssueJson }>(`/api/issues/${issue!.id}/send-back`, {
        method: 'POST',
        body: JSON.stringify({ note: reason.trim() }),
      }),
    );
    if (!res) return;
    setData((d) => ({ ...d!, issue: res.issue }));
    setSending(false);
    setReason('');
  }

  const waitingSpec = template === 'spec' && issue.stage === 'spec_ready';
  const question =
    issue.stage === 'merge_question' && issue.prUrl !== null && !issue.mergeRequestedAt;
  const approved = issue.approvedAt
    ? `Approved ${issue.approvedVia === 'magpipe' ? 'in Magpipe' : 'in Linear'} at ${clockTime(new Date(issue.approvedAt))}.`
    : null;
  const done = PIPELINE_LABELS.done.toLowerCase();
  const caption = issue.mergedAt
    ? `Merged at ${clockTime(new Date(issue.mergedAt))}.`
    : issue.mergeRequestedAt
      ? `Merge requested ${issue.mergeRequestedVia === 'linear' ? 'in Linear' : 'in Magpipe'} at ${clockTime(new Date(issue.mergeRequestedAt))}: the branch is brought up to date and tested again first.`
      : waitingSpec
        ? 'Waiting for you: approve it here, or move it to the approved status in Linear.'
        : question
          ? `Waiting for you: merge it or send it back here, move it to ${done} in Linear, or merge the pull request on GitHub.`
          : issue.stage === 'merge_question'
            ? `Ready to merge: the issue names the branch. Merge it, then move the issue to ${done} in Linear.`
            : issue.stage === 'needs_you'
              ? `Needs you: the findings are on the issue. Move it back to ${PIPELINE_LABELS.approved.toLowerCase()} in Linear to try again.`
              : (approved ?? `Linear status: ${issue.stateName}.`);

  return (
    <section aria-label="Linear issue" className={clsx('flex flex-col gap-3 card p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <ExternalA href={issue.url}>{issue.identifier}</ExternalA>
          <Badge tone={stageTone(issue.stage)}>{stageText(issue)}</Badge>
          {issue.prUrl ? <ExternalA href={issue.prUrl}>{`PR #${issue.prNumber}`}</ExternalA> : null}
        </div>
        {waitingSpec ? (
          <Button variant={emphasis} size="sm" loading={busy === 'approve'} onClick={approve}>
            Approve the spec
          </Button>
        ) : question && !sending ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setSending(true)}
            >
              Send back
            </Button>
            <Button variant={emphasis} size="sm" loading={busy === 'merge'} onClick={merge}>
              Merge
            </Button>
          </div>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-body-sm text-ink">{issue.title}</p>
      <p className="text-caption text-mute">{caption}</p>
      {question && sending ? (
        <div className="flex flex-col gap-3">
          <Textarea
            label="What should change"
            description="Posted on the issue and given to the Code Agent; the goal is built again on its branch."
            rows={3}
            value={reason}
            error={reasonError}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError(undefined);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy === 'send'} onClick={sendBack}>
              Send it back
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setSending(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {data.goalsRun ? <RunLinkLine label="Goals: split in" run={data.goalsRun} /> : null}
      {data.landRun ? <RunLinkLine label="Merge: landing in" run={data.landRun} /> : null}
      {data.goals.length > 0 ? (
        <ul aria-label="Goals" className="flex flex-col gap-2 border-t border-hairline-soft pt-3">
          {data.goals.map((g) => (
            <li key={g.id} className="flex min-w-0 items-center gap-3">
              <ExternalA href={g.url}>{g.identifier}</ExternalA>
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
