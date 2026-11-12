'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { Input } from '@/components/arc/input/input';
import { Button } from '@/components/ui/Button';
import { removeForgeKeyAction, saveForgeKeyAction } from '@/app/(shell)/settings/actions';
import type { ForgeView } from '@/lib/forge';

type Props = {
  initial: ForgeView;
  /** When set, nothing can be saved and this says why. */
  disabledReason?: string;
};

type Note = { tone: 'done' | 'error'; text: string } | null;

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Settings → GitHub (D42, D46): the token every project shares, pasted once and never shown
 * again. Each project names its own repository, merge method and unattended rule on its page.
 */
export function GitHubForm({ initial, disabledReason }: Props) {
  const router = useRouter();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const run = (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  if (disabledReason) return <p className="text-caption text-mute">{disabledReason}</p>;

  function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return setKeyError('Paste a GitHub token.');
    run('key', async () => {
      const res = await saveForgeKeyAction({ key });
      if (!res.ok) return setKeyError(res.message);
      setView(res.view);
      setKey('');
      setReplacing(false);
      setNote({ tone: 'done', text: `Saved. GitHub knows this token as ${res.view.viewer}.` });
      router.refresh();
    });
  }

  function removeKey() {
    run('remove', async () => {
      const res = await removeForgeKeyAction();
      if (!res.ok) return setNote({ tone: 'error', text: res.message });
      setView(res.view);
      setNote({
        tone: 'done',
        text: 'Removed. Projects without a token of their own stop at a branch to merge by hand.',
      });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-8 md:grid-cols-2 md:items-start">
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Token</h3>
        {view.hasKey && !replacing ? (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-body-sm text-mute">Token</dt>
              <dd className="text-code text-ink" style={MONO}>
                ends in {view.keyHint}
              </dd>
              <dt className="text-body-sm text-mute">GitHub user</dt>
              <dd className="text-body-sm text-ink">{view.viewer}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => setReplacing(true)}>
                Replace token
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === 'remove'}
                disabled={pending && busy !== 'remove'}
                onClick={removeKey}
              >
                Remove token
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={saveKey} noValidate className="flex flex-col gap-3">
            <Input
              id={`${ids}-key`}
              label="Token"
              description="A fine-grained token for your projects’ repositories, with read and write access to contents and pull requests. Magpipe checks it with GitHub, stores it encrypted and never shows it again."
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              readOnly={pending}
              error={keyError}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyError(undefined);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                loading={busy === 'key'}
                disabled={pending && busy !== 'key'}
              >
                Save token
              </Button>
              {replacing ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setReplacing(false)}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Repositories</h3>
        <p className="max-w-[31rem] text-body-sm text-body">
          Each project names its own repository, how its pull requests merge and whether they may
          merge without asking, on its page in{' '}
          <Link href="/factory" className="text-ink underline underline-offset-2">
            Factory
          </Link>
          . A project in another account can carry a token of its own there.
        </p>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          note?.tone === 'error'
            ? 'text-body-sm text-danger md:col-span-2'
            : 'text-body-sm text-emerald md:col-span-2'
        }
      >
        {note?.text ?? ''}
      </p>
    </div>
  );
}
