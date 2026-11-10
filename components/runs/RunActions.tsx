'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { LIVE } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';

type Props = {
  run: Pick<Run, 'id' | 'displayId' | 'status'>;
  size?: 'sm' | 'md';
  /** Also offer "Open log", the link to the flight's own page. */
  showOpen?: boolean;
  /** Ghost beside Open log; secondary where Re-fly is the page's own action. */
  reflyVariant?: 'ghost' | 'secondary';
};

/** Re-fly (a new run with the same input) and, while the run is live, Cancel (spec §3.4). */
export function RunActions({ run, size = 'md', showOpen = false, reflyVariant = 'ghost' }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<'refly' | 'cancel' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = LIVE.has(run.status);

  async function refly() {
    setBusy('refly');
    setNotice(null);
    try {
      const { run: next } = await api<{ run: { displayId: string } }>(`/api/runs/${run.id}/refly`, {
        method: 'POST',
      });
      router.push(`/runs/${next.displayId}`);
    } catch (err) {
      setBusy(null);
      setNotice(err instanceof ApiError ? err.message : 'The new run could not be started.');
    }
  }

  async function cancel() {
    setBusy('cancel');
    setNotice(null);
    try {
      await api(`/api/runs/${run.id}/cancel`, { method: 'POST' });
      setNotice('Cancelling…');
      router.refresh();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'The run could not be cancelled.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showOpen ? (
        <ButtonLink href={`/runs/${run.displayId}`} variant="secondary" size={size}>
          Open log
        </ButtonLink>
      ) : null}
      <Button
        variant={reflyVariant}
        size={size}
        onClick={refly}
        loading={busy === 'refly'}
        disabled={busy === 'cancel'}
      >
        Re-fly
      </Button>
      {live ? (
        <Button
          variant="danger"
          size={size}
          onClick={cancel}
          loading={busy === 'cancel'}
          disabled={busy === 'refly'}
        >
          Cancel
        </Button>
      ) : null}
      {notice ? (
        <span role="status" className="text-caption text-mute">
          {notice}
        </span>
      ) : null}
    </div>
  );
}
