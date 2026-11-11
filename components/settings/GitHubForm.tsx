'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import {
  removeForgeKeyAction,
  saveAutoMergeAction,
  saveForgeKeyAction,
  saveForgeRepoAction,
} from '@/app/(shell)/settings/actions';
import type { ForgeView } from '@/lib/forge';
import type { ForgeRepoInput } from '@/lib/schemas';

type Props = {
  initial: ForgeView;
  /** `owner/name` read from the factory repository's origin, to start the field with. */
  suggestedRepo?: string | null;
  /** When set, nothing can be saved and this says why. */
  disabledReason?: string;
};

type Note = { tone: 'done' | 'error'; text: string } | null;

const MONO = { fontFamily: 'var(--font-mono)' } as const;

const METHODS = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
];

/**
 * Settings → GitHub (D42): the token, pasted once and never shown again, and the repository the
 * factory opens pull requests on, checked with GitHub when saved, with how they merge.
 */
export function GitHubForm({ initial, suggestedRepo, disabledReason }: Props) {
  const router = useRouter();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [repo, setRepo] = useState(initial.repo ?? suggestedRepo ?? '');
  const [repoError, setRepoError] = useState<string>();
  const [method, setMethod] = useState<ForgeRepoInput['mergeMethod']>(initial.mergeMethod);
  const [note, setNote] = useState<Note>(null);
  const [auto, setAuto] = useState(initial.autoMerge);
  const [autoLabel, setAutoLabel] = useState(initial.autoMergeLabel);
  const [firstPass, setFirstPass] = useState(initial.autoMergeFirstPass);
  const [checks, setChecks] = useState(initial.autoMergeChecks);
  const [labelError, setLabelError] = useState<string>();
  const [ruleNote, setRuleNote] = useState<Note>(null);

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
      setNote({ tone: 'done', text: 'Removed. Goals stop at a branch ready to merge by hand.' });
      router.refresh();
    });
  }

  function saveRepo(e: FormEvent) {
    e.preventDefault();
    run('repo', async () => {
      const res = await saveForgeRepoAction({ repo, mergeMethod: method });
      if (!res.ok) return setRepoError(res.message);
      setView(res.view);
      setRepoError(undefined);
      setNote({
        tone: 'done',
        text: `Read back from GitHub: ${res.view.repo}, default branch ${res.defaultBranch}.`,
      });
      router.refresh();
    });
  }

  function saveRule(e: FormEvent) {
    e.preventDefault();
    run('rule', async () => {
      const res = await saveAutoMergeAction({
        autoMerge: auto,
        autoMergeLabel: autoLabel,
        autoMergeFirstPass: firstPass,
        autoMergeChecks: checks,
      });
      if (!res.ok) {
        if (res.field === 'autoMergeLabel') setLabelError(res.message);
        else setRuleNote({ tone: 'error', text: res.message });
        return;
      }
      setView(res.view);
      setLabelError(undefined);
      setRuleNote({
        tone: 'done',
        text: res.view.autoMerge
          ? `Saved. Goals labelled ${res.view.autoMergeLabel} merge without asking when the rule holds.`
          : 'Saved. Every merge waits for your answer.',
      });
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
              description="A fine-grained token for the one repository, with read and write access to contents and pull requests. Magpipe checks it with GitHub, stores it encrypted and never shows it again."
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
      <form onSubmit={saveRepo} noValidate className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Repository</h3>
        {view.hasKey ? (
          <>
            <Input
              id={`${ids}-repo`}
              label="Repository"
              description="owner/name on GitHub: where the factory pushes goal branches and opens pull requests."
              autoComplete="off"
              spellCheck={false}
              style={MONO}
              value={repo}
              readOnly={pending}
              error={repoError}
              onChange={(e) => {
                setRepo(e.target.value);
                setRepoError(undefined);
              }}
            />
            <Select
              label="How pull requests merge"
              options={METHODS}
              value={method}
              onValueChange={(v) => setMethod(v as ForgeRepoInput['mergeMethod'])}
              disabled={pending}
            />
            <div>
              <Button
                type="submit"
                size="sm"
                loading={busy === 'repo'}
                disabled={pending && busy !== 'repo'}
              >
                Save and read back
              </Button>
            </div>
          </>
        ) : (
          <p className="max-w-[31rem] text-body-sm text-body">
            Save a token first: Magpipe checks the repository with it.
          </p>
        )}
      </form>
      <form onSubmit={saveRule} noValidate className="flex flex-col gap-3 md:col-span-2">
        <h3 className="font-medium text-body text-ink">Unattended merges</h3>
        <p className="max-w-[31rem] text-body-sm text-body">
          Off unless you turn it on. When every condition below holds for a goal at the question to
          merge, the question answers itself; the goal is still brought up to date, tested again and
          checked before it merges, and anything that fails comes back to you.
        </p>
        <Checkbox
          label="Merge without asking when the rule holds"
          description={
            view.ready
              ? 'Applies at the next check to goals waiting at the question to merge.'
              : 'Needs the token and the repository above.'
          }
          checked={auto}
          disabled={!view.ready}
          onCheckedChange={(on) => setAuto(on === true)}
        />
        <div className="max-w-[20rem]">
          <Input
            id={`${ids}-auto-label`}
            label="Label it needs"
            description="On the goal or its spec in Linear. Only labelled work merges by itself."
            autoComplete="off"
            spellCheck={false}
            value={autoLabel}
            readOnly={pending}
            error={labelError}
            onChange={(e) => {
              setAutoLabel(e.target.value);
              setLabelError(undefined);
            }}
          />
        </div>
        <Checkbox
          label="Only when every judge passed on the first try"
          description="A goal whose tests, review or skeptic sent the work back waits for you."
          checked={firstPass}
          onCheckedChange={(on) => setFirstPass(on === true)}
        />
        <Checkbox
          label="Only when the pull request’s checks are green"
          description="Checks still running mean wait; failed checks, or none at all, mean ask you."
          checked={checks}
          onCheckedChange={(on) => setChecks(on === true)}
        />
        <div>
          <Button
            type="submit"
            size="sm"
            loading={busy === 'rule'}
            disabled={pending && busy !== 'rule'}
          >
            Save the rule
          </Button>
        </div>
        <p
          role="status"
          aria-live="polite"
          className={
            ruleNote?.tone === 'error' ? 'text-body-sm text-danger' : 'text-body-sm text-emerald'
          }
        >
          {ruleNote?.text ?? ''}
        </p>
      </form>
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
