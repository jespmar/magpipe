'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/arc/badge/badge';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { clockTime } from '@/lib/home-util';
import type { Run, TrackerIssue } from '@/lib/schemas';
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

/**
 * The Linear issue a spec run filed (D38): its identifier and stage, and gate G1's Magpipe door.
 * Approve sets the approved status in Linear, so Linear holds the one answer. Nothing shows for a
 * run that filed no issue.
 */
export function IssueBar({ run, emphasis = 'primary', className }: Props) {
  const [issue, setIssue] = useState<IssueJson | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const spec = run.input.template === 'spec' && run.status === 'done';

  useEffect(() => {
    if (!spec) return;
    let live = true;
    api<{ issue: IssueJson | null }>(`/api/runs/${run.id}/issue`)
      .then(({ issue }) => live && setIssue(issue))
      .catch(() => live && setIssue(null));
    return () => {
      live = false;
    };
  }, [run.id, spec]);

  if (!spec || !issue) return null;

  async function approve() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await api<{ issue: IssueJson }>(`/api/issues/${issue!.id}/approve`, {
        method: 'POST',
        body: '{}',
      });
      setIssue(res.issue);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Linear could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const waiting = issue.stage === 'spec_ready';
  const approved = issue.approvedAt
    ? `Approved ${issue.approvedVia === 'magpipe' ? 'in Magpipe' : 'in Linear'} at ${clockTime(new Date(issue.approvedAt))}.`
    : null;

  return (
    <section aria-label="Linear issue" className={clsx('flex flex-col gap-3 card p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-code text-ink hover:text-ink-strong"
          >
            {issue.identifier}
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
            <span className="sr-only">(opens Linear)</span>
          </a>
          <Badge tone={waiting ? 'warning' : issue.stage === 'done' ? 'success' : 'neutral'}>
            {issue.stage === 'other' ? issue.stateName : PIPELINE_LABELS[issue.stage].toLowerCase()}
          </Badge>
        </div>
        {waiting ? (
          <Button variant={emphasis} size="sm" loading={busy} onClick={approve}>
            Approve the spec
          </Button>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-body-sm text-ink">{issue.title}</p>
      <p className="text-caption text-mute">
        {waiting
          ? 'Waiting for you: approve it here, or move it to the approved status in Linear.'
          : (approved ?? `In ${issue.stateName} in Linear.`)}
      </p>
      {problem ? (
        <p role="alert" className="text-body-sm text-danger">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
