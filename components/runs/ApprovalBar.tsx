'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { clsx } from 'clsx';
import { Alert } from '@/components/arc/alert/alert';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { awaitingApproval } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';

type Props = {
  run: Pick<Run, 'id' | 'status' | 'plan'>;
  /** The run page's one primary action; secondary where the surface has its own (Home's Run). */
  emphasis?: 'primary' | 'secondary';
  className?: string;
};

/**
 * A run held for the operator (D30): what it waits on, a note for the steps that come next, and
 * the two ways on: approve, or cancel the run. Nothing shows for a run that is not waiting.
 */
export function ApprovalBar({ run, emphasis = 'primary', className }: Props) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'cancel' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (run.status !== 'waiting') return null;

  const held = awaitingApproval(run.plan);
  const what = held.length > 0 ? held.map((s) => `“${s.title}”`).join(' and ') : 'the last step';

  async function act(kind: 'approve' | 'cancel') {
    setBusy(kind);
    setProblem(null);
    try {
      await api(`/api/runs/${run.id}/${kind}`, {
        method: 'POST',
        body: kind === 'approve' && note.trim() ? JSON.stringify({ note: note.trim() }) : '{}',
      });
      setNote('');
      router.refresh();
    } catch (err) {
      setProblem(
        err instanceof ApiError
          ? err.message
          : kind === 'approve'
            ? 'The run could not go on. Try again.'
            : 'The run could not be cancelled. Try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Approval" className={clsx('flex min-w-0 flex-col gap-3', className)}>
      <Alert tone="warning" title="Waiting for you">
        {`Approve ${what} to let the next steps start, or cancel the run.`}
      </Alert>
      <Textarea
        label="Note for the next steps (optional)"
        rows={2}
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Anything they should know, such as an assumption you struck from the plan…"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {problem ? (
          <p role="alert" className="mr-auto text-body-sm text-danger">
            {problem}
          </p>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => void act('cancel')}
          loading={busy === 'cancel'}
          disabled={busy === 'approve'}
        >
          Cancel run
        </Button>
        <Button
          variant={emphasis}
          onClick={() => void act('approve')}
          loading={busy === 'approve'}
          disabled={busy === 'cancel'}
        >
          Approve and go on
        </Button>
      </div>
    </section>
  );
}
