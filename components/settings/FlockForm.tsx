'use client';

import { useRouter } from 'next/navigation';
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Input } from '@/components/arc/input/input';
import { Button, ButtonLink } from '@/components/ui/Button';
import { plural } from '@/lib/format';
import type { FlockLoadInput } from '@/lib/schemas';
import { loadFlockAction, type FlockState } from '@/app/(shell)/settings/actions';

type Field = 'path' | 'scripts';

type Props = {
  /** The scripts the form starts with, from lib/flock.ts. */
  defaultScripts: string[];
  /** How many `decisions` entries the flock writes, so the confirm copy cannot drift. */
  decisions: number;
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/** The last part of a path, for the confirm copy: `/Users/you/code/app/` is `app`. */
function folderName(path: string): string {
  return (
    path
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || 'the folder'
  );
}

/**
 * Load the development flock (D35), shaped like the demo data's form: the folder and the scripts,
 * a confirm step that says what will change before anything is written, a pending state on the
 * button, and the result in a live region that is always mounted. A folder or script the server
 * refuses comes back on its field.
 */
export function FlockForm({ defaultScripts, decisions, disabledReason }: Props) {
  const router = useRouter();
  const [state, action, pending] = useActionState<FlockState, FlockLoadInput>(loadFlockAction, {
    status: 'idle',
  });
  const [folder, setFolder] = useState('');
  const [scripts, setScripts] = useState(defaultScripts.join(', '));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const scriptsRef = useRef<HTMLInputElement>(null);
  const focusTrigger = useRef(false);

  // Leaving the confirm step by Cancel or a result: focus goes back to the trigger once it is
  // mounted again, unless a field has an error to fix.
  useEffect(() => {
    if (confirming || !focusTrigger.current) return;
    focusTrigger.current = false;
    triggerRef.current?.focus();
  }, [confirming]);

  // When a result lands: close the confirm step, put an error on its field, re-read the page.
  useEffect(() => {
    if (state.status === 'idle') return;
    if (state.status === 'error' && state.field) {
      setErrors({ [state.field]: state.message });
      (state.field === 'path' ? pathRef : scriptsRef).current?.focus();
    } else {
      focusTrigger.current = true;
    }
    if (state.status === 'done') {
      setErrors({});
      router.refresh();
    }
    setConfirming(false);
  }, [state, router]);

  if (disabledReason) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button variant="secondary" size="sm" disabled aria-describedby="flock-disabled-why">
            Load the development flock
          </Button>
        </div>
        <p id="flock-disabled-why" className="text-caption text-mute">
          {disabledReason}
        </p>
      </div>
    );
  }

  /** The checks the browser can make; the server checks the folder and its package.json. */
  function check(): boolean {
    const next: Partial<Record<Field, string>> = {};
    if (!ABSOLUTE.test(folder.trim())) {
      next.path = 'Give the folder as an absolute path, such as /Users/you/code/app.';
    }
    if (!scripts.split(/[\s,]+/).some(Boolean)) {
      next.scripts = 'Name at least one script, such as test: the Verifier runs the checks.';
    }
    setErrors(next);
    if (next.path) pathRef.current?.focus();
    else if (next.scripts) scriptsRef.current?.focus();
    return !next.path && !next.scripts;
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !check()) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(() => action({ path: folder, scripts }));
  }

  const formError = state.status === 'error' && !state.field ? state.message : null;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Input
        ref={pathRef}
        label="Repository folder"
        description="An absolute path inside a git repository."
        name="path"
        placeholder="/Users/you/code/app"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={folder}
        readOnly={pending}
        error={errors.path}
        onChange={(e) => {
          setFolder(e.target.value);
          setErrors((x) => ({ ...x, path: undefined }));
        }}
      />
      <Input
        ref={scriptsRef}
        label="Scripts agents may run"
        description="Names from its package.json, separated by commas. The Verifier runs them as the checks."
        name="scripts"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={scripts}
        readOnly={pending}
        error={errors.scripts}
        onChange={(e) => {
          setScripts(e.target.value);
          setErrors((x) => ({ ...x, scripts: undefined }));
        }}
      />

      <div className="flex flex-col">
        {/* Always mounted so screen readers hear the change when the result arrives. */}
        <div role="status" aria-live="polite">
          {state.status === 'done' ? (
            <div className="flex flex-col gap-3 pb-4">
              <p className="text-body-sm font-medium text-emerald">Done.</p>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <div className="contents">
                  <dt className="text-body-sm text-mute">Folder</dt>
                  <dd className="font-mono text-code break-all text-ink select-all">
                    {state.path}
                  </dd>
                </div>
                {state.lines.map((line) => (
                  <div key={line.label} className="contents">
                    <dt className="text-body-sm text-mute">{line.label}</dt>
                    <dd className="text-body-sm text-body">{line.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {formError ? <p className="pb-3 text-body-sm text-danger">{formError}</p> : null}
        </div>

        {confirming ? (
          <div className="flex flex-col gap-3">
            <p className="text-body-sm text-ink">
              This binds <span className="font-mono text-code break-all">{folderName(folder)}</span>{' '}
              and its docs/plans folder as repository tools, adds Planner and Verifier, gives
              Researcher, Coder and Reviewer new prompts, memory and grants on those folders, writes{' '}
              {plural(decisions, 'decisions entry', 'decisions entries')} and pauses Operator.
              Grants to other tools, and anything else you made, are left alone.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={pending}
                // The button that opened this step has unmounted; land focus here, not on <body>.
                autoFocus
              >
                Load the flock
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  focusTrigger.current = true;
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button ref={triggerRef} type="submit" variant="secondary" size="sm">
              {state.status === 'done' ? 'Load it again' : 'Load the development flock'}
            </Button>
            {state.status === 'done' ? (
              <ButtonLink href="/agents?agent=planner" variant="ghost" size="sm">
                See the agents
              </ButtonLink>
            ) : null}
          </div>
        )}
      </div>
    </form>
  );
}
