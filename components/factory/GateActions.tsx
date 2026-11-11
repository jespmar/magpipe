'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';

type Props = {
  issueId: string;
  identifier: string;
  /** Gate G1 on a spec waiting for approval, or G2 on a goal at the merge question. */
  gate: 'approve' | 'question';
};

/**
 * A gate's Magpipe door on a factory card (D43): Approve on a spec; Merge or Send back with a
 * note on a goal. Each sets Linear first; the board then re-reads itself.
 */
export function GateActions({ issueId, identifier, gate }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'merge' | 'send' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string>();

  async function act(kind: 'approve' | 'merge' | 'send', path: string, body: unknown = {}) {
    setBusy(kind);
    setProblem(null);
    try {
      await api(`/api/issues/${issueId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setSending(false);
      setNote('');
      router.refresh();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Linear could not be reached. Try again.');
    } finally {
      setBusy(null);
    }
  }

  if (gate === 'approve') {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button
            size="sm"
            loading={busy === 'approve'}
            onClick={() => act('approve', 'approve')}
            aria-label={`Approve ${identifier}`}
          >
            Approve
          </Button>
        </div>
        {problem ? (
          <p role="alert" className="text-caption text-danger">
            {problem}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sending ? (
        <>
          <Textarea
            label="What should change"
            description="Posted on the issue and given to the Code Agent."
            rows={3}
            value={note}
            error={noteError}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(undefined);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy === 'send'}
              onClick={() =>
                note.trim()
                  ? act('send', 'send-back', { note: note.trim() })
                  : setNoteError('Say what should change.')
              }
            >
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
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy === 'merge'}
            onClick={() => act('merge', 'merge')}
            aria-label={`Merge ${identifier}`}
          >
            Merge
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setSending(true)}
            aria-label={`Send ${identifier} back`}
          >
            Send back
          </Button>
        </div>
      )}
      {problem ? (
        <p role="alert" className="text-caption text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
