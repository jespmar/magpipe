'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition, type FormEvent } from 'react';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Input } from '@/components/arc/input/input';
import { Button } from '@/components/ui/Button';
import {
  checkLinearAction,
  cancelLinearSignInAction,
  linearStatusAction,
  removeLinearKeyAction,
  saveLinearClientIdAction,
  saveLinearKeyAction,
  startLinearSignInAction,
  saveWatcherAction,
} from '@/app/(shell)/settings/actions';
import { clockTime } from '@/lib/home-util';
import type { LinearView } from '@/lib/tracker';

type Props = {
  initial: LinearView;
  /** Where Linear sends the browser back after Sign in with Linear, as the server builds it. */
  callbackUrl: string;
  /** When set, nothing can be saved and this says why. */
  disabledReason?: string;
};

type Note = { tone: 'done' | 'error'; text: string } | null;

const MONO = { fontFamily: 'var(--font-mono)' } as const;

function NoteLine({ note }: { note: Note }) {
  // Always mounted, so a screen reader hears the result when it lands.
  return (
    <p
      role="status"
      aria-live="polite"
      className={note?.tone === 'error' ? 'text-body-sm text-danger' : 'text-body-sm text-emerald'}
    >
      {note?.text ?? ''}
    </p>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-body-sm text-mute">{label}</dt>
      <dd className="min-w-0 text-body-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * Settings → Linear (D38, D46, D47): the sign-in every project shares, Sign in with Linear (OAuth,
 * renewed by itself) or a key pasted once and never shown again,
 * and the watcher's pace, with the last check and Check now. Each project maps its own team,
 * Linear project and statuses on its page.
 */
export function LinearForm({ initial, callbackUrl, disabledReason }: Props) {
  const router = useRouter();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  // the key
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string>();
  const [replacing, setReplacing] = useState(false);
  const [keyNote, setKeyNote] = useState<Note>(null);

  // Sign in with Linear (D47): the OAuth app's client ID, and a sign-in under way.
  const [clientId, setClientId] = useState('');
  const [clientError, setClientError] = useState<string>();
  const [signingIn, setSigningIn] = useState<{
    state: string;
    url: string;
    at: number;
    /** The browser kept the new window from opening: the link opens Linear instead. */
    blocked: boolean;
  } | null>(null);

  // the watcher
  const [seconds, setSeconds] = useState(String(initial.pollSeconds));
  const [paused, setPaused] = useState(initial.paused);
  const [secondsError, setSecondsError] = useState<string>();
  const [watchNote, setWatchNote] = useState<Note>(null);

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

  // While a sign-in is under way, ask every two seconds how it is going; the server forgets a
  // sign-in after ten minutes, and says so.
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(async () => {
      const res = await linearStatusAction(signingIn.state);
      if (!res.ok || !res.outcome || res.outcome.status === 'waiting') return;
      setSigningIn(null);
      setView(res.view);
      const o = res.outcome;
      setKeyNote(
        o.status === 'done'
          ? { tone: 'done', text: `Signed in with Linear as ${o.viewer ?? res.view.viewer}.` }
          : o.status === 'failed'
            ? { tone: 'error', text: o.message }
            : { tone: 'error', text: 'The sign-in ended before Linear came back. Start it again.' },
      );
      if (o.status === 'done') router.refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [signingIn, router]);

  if (disabledReason) {
    return <p className="text-caption text-mute">{disabledReason}</p>;
  }

  function startSignIn() {
    setKeyNote(null);
    if (signingIn) void cancelLinearSignInAction(signingIn.state);
    setSigningIn(null);
    // A browser only opens a window during the click itself, so open it now and point it at
    // Linear once the address is known. The desktop app opens Linear in the system browser.
    const desktop = 'magpipeDesktop' in window;
    const tab = desktop ? null : window.open('', '_blank');
    run('signin', async () => {
      const res = await startLinearSignInAction();
      if (!res.ok) {
        tab?.close();
        return setKeyNote({ tone: 'error', text: res.message });
      }
      let blocked = false;
      if (desktop) {
        window.open(res.url, '_blank');
      } else if (tab) {
        tab.opener = null;
        tab.location.href = res.url;
      } else {
        blocked = true;
      }
      setSigningIn({ state: res.state, url: res.url, at: Date.now(), blocked });
    });
  }

  function cancelSignIn() {
    if (signingIn) void cancelLinearSignInAction(signingIn.state);
    setSigningIn(null);
    setKeyNote({ tone: 'done', text: 'Sign-in cancelled.' });
  }

  function saveClientId(value: string) {
    run('client', async () => {
      const res = await saveLinearClientIdAction(value);
      if (!res.ok) return setClientError(res.message);
      setView(res.view);
      setClientId('');
      setKeyNote(
        value
          ? { tone: 'done', text: 'Saved. Sign in with Linear is ready.' }
          : { tone: 'done', text: 'Forgot the OAuth app. Add another, or paste a key.' },
      );
    });
  }

  function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setKeyError('Paste the API key from Linear.');
      return;
    }
    run('key', async () => {
      const res = await saveLinearKeyAction({ key });
      if (!res.ok) {
        setKeyError(res.message);
        return;
      }
      setView(res.view);
      setKey('');
      setReplacing(false);
      setKeyError(undefined);
      setKeyNote({
        tone: 'done',
        text: `Saved. Linear knows this key as ${res.view.viewer}; it sees ${res.teams.length === 1 ? 'one team' : `${res.teams.length} teams`} for your projects.`,
      });
      router.refresh();
    });
  }

  function removeKey() {
    const signedIn = view.keyKind === 'oauth';
    run('remove', async () => {
      const res = await removeLinearKeyAction();
      if (!res.ok) return setKeyNote({ tone: 'error', text: res.message });
      setView(res.view);
      setKeyNote({
        tone: 'done',
        text: signedIn
          ? 'Signed out of Linear. Projects without a key of their own stop filing until you sign in again.'
          : 'Removed. Projects without a key of their own stop filing until a new one is saved.',
      });
      router.refresh();
    });
  }

  function saveWatch(e: FormEvent) {
    e.preventDefault();
    run('watch', async () => {
      const res = await saveWatcherAction({ pollSeconds: Number(seconds), paused });
      if (!res.ok) {
        setSecondsError(res.message);
        return;
      }
      setSecondsError(undefined);
      setView(res.view);
      setWatchNote({
        tone: 'done',
        text: res.view.paused
          ? 'Saved. The watcher is paused.'
          : `Saved. The watcher checks every ${res.view.pollSeconds} seconds.`,
      });
    });
  }

  function checkNow() {
    run('check', async () => {
      const res = await checkLinearAction();
      if (!res.ok) return setWatchNote({ tone: 'error', text: res.message });
      setView(res.view);
      const c = res.check;
      setWatchNote(
        c.status === 'done'
          ? {
              tone: 'done',
              text: `Checked: ${c.issues === 1 ? 'one issue' : `${c.issues} issues`} with the label changed since the last check, ${c.changed} moved.${
                c.started.length ? ` Started ${c.started.join(', ')}.` : ''
              }`,
            }
          : c.status === 'error'
            ? { tone: 'error', text: c.message }
            : {
                tone: 'error',
                text:
                  c.reason === 'busy'
                    ? 'A check is already running.'
                    : 'Save a key, and give a project its Linear project, first.',
              },
      );
      router.refresh();
    });
  }

  // The last check that worked; a failure since then shows as the last error beneath it.
  const lastCheck = view.lastCheckAt
    ? `${clockTime(new Date(view.lastCheckAt))}${
        view.lastCheck
          ? `: ${view.lastCheck.issues === 1 ? 'one issue' : `${view.lastCheck.issues} issues`} seen, ${view.lastCheck.changed} moved`
          : ''
      }`
    : 'not yet';

  return (
    // Three parts side by side on a wide screen: the key, the mapping, the watcher.
    <div className="grid gap-8 md:grid-cols-3 md:items-start">
      {/* The key, or the sign-in (D47) */}
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Sign-in</h3>
        {view.hasKey && view.keyKind === 'oauth' ? (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <Fact label="Linear user">{view.viewer}</Fact>
              <Fact label="Signed in">
                {view.signInExpired ? (
                  <span className="text-amber">with Linear; the sign-in expired</span>
                ) : (
                  'with Linear; the token renews by itself'
                )}
              </Fact>
            </dl>
            <div className="flex flex-wrap gap-2">
              {view.signInExpired && view.signInClientId ? (
                <Button
                  size="sm"
                  onClick={startSignIn}
                  loading={busy === 'signin'}
                  disabled={pending && busy !== 'signin'}
                >
                  Sign in with Linear again
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={removeKey}
                loading={busy === 'remove'}
                disabled={pending && busy !== 'remove'}
              >
                Sign out
              </Button>
            </div>
          </>
        ) : view.hasKey && !replacing ? (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <Fact label="Key">
                <span style={MONO} className="text-code">
                  ends in {view.keyHint}
                </span>
              </Fact>
              <Fact label="Linear user">{view.viewer}</Fact>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setReplacing(true)} disabled={pending}>
                Replace key
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={removeKey}
                loading={busy === 'remove'}
                disabled={pending && busy !== 'remove'}
              >
                Remove key
              </Button>
            </div>
          </>
        ) : (
          <>
            {view.signInClientId ? (
              <div className="flex flex-col gap-2">
                <p className="max-w-[31rem] text-body-sm text-body">
                  Linear opens in your browser to ask whether Magpipe may work in your workspace.
                  Nothing to paste; the sign-in renews by itself.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={startSignIn}
                    loading={busy === 'signin'}
                    disabled={pending && busy !== 'signin'}
                  >
                    {signingIn ? 'Start again' : 'Sign in with Linear'}
                  </Button>
                  {signingIn ? (
                    <>
                      <a
                        href={signingIn.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-body-sm text-ink underline underline-offset-2"
                      >
                        {signingIn.blocked ? 'Open Linear' : 'Open Linear again'}
                      </a>
                      <Button size="sm" variant="ghost" onClick={cancelSignIn}>
                        Cancel
                      </Button>
                    </>
                  ) : view.oauthClientId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => saveClientId('')}
                      disabled={pending}
                    >
                      Use another OAuth app
                    </Button>
                  ) : null}
                </div>
                {signingIn ? (
                  <p className="text-body-sm text-mute">
                    {signingIn.blocked
                      ? 'Your browser kept Linear from opening in a new window: open it with the link.'
                      : 'Waiting for Linear in your browser. Allow Magpipe there, then come back.'}
                  </p>
                ) : null}
                <p className="text-caption text-mute">
                  Linear sends the browser back to{' '}
                  <span className="font-mono text-code break-all">{callbackUrl}</span>; the OAuth
                  app needs this callback URL.
                </p>
              </div>
            ) : (
              <form
                noValidate
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveClientId(clientId);
                }}
              >
                <p className="max-w-[31rem] text-body-sm text-body">
                  To sign in with Linear instead of pasting a key, add Magpipe as an OAuth app in
                  Linear once: Settings, API, OAuth applications, with this callback URL.
                </p>
                <p className="font-mono text-code break-all text-ink">{callbackUrl}</p>
                <Input
                  id={`${ids}-client`}
                  label="OAuth app client ID"
                  description="Public: Magpipe uses PKCE, so the app’s secret is not needed. Or set MAGPIPE_LINEAR_CLIENT_ID in magpipe.env."
                  autoComplete="off"
                  spellCheck={false}
                  style={MONO}
                  value={clientId}
                  readOnly={pending}
                  error={clientError}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setClientError(undefined);
                  }}
                />
                <div>
                  <Button
                    type="submit"
                    size="sm"
                    loading={busy === 'client'}
                    disabled={pending && busy !== 'client'}
                  >
                    Save client ID
                  </Button>
                </div>
              </form>
            )}
            <form onSubmit={saveKey} noValidate className="flex flex-col gap-3">
              <Input
                id={`${ids}-key`}
                label={view.hasKey ? 'New personal API key' : 'Or paste a personal API key'}
                description="From Linear: Settings, Account, Security and access. Magpipe checks it with Linear, stores it encrypted and never shows it again."
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
                  Save key
                </Button>
                {replacing ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setReplacing(false)}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          </>
        )}
        <NoteLine note={keyNote} />
      </div>

      {/* Where the mapping lives now (D46) */}
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Teams and projects</h3>
        <p className="max-w-[31rem] text-body-sm text-body">
          Each project picks its own team, Linear project, label and statuses on its page in{' '}
          <Link href="/factory" className="text-ink underline underline-offset-2">
            Factory
          </Link>
          . This key serves every project; one in another workspace can carry a key of its own
          there.
        </p>
      </div>

      {/* The watcher */}
      <form onSubmit={saveWatch} noValidate className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Watcher</h3>
        <p className="max-w-[31rem] text-body-sm text-body">
          While Magpipe is open it checks Linear for issues with the label, so moving one to the
          approved status there approves it here. When the app opens again it catches up.
        </p>
        <div className="max-w-[16rem]">
          <Input
            id={`${ids}-seconds`}
            label="Check every, in seconds"
            description="From 15 to 1800."
            type="number"
            min={15}
            max={1800}
            style={MONO}
            value={seconds}
            readOnly={pending}
            error={secondsError}
            onChange={(e) => {
              setSeconds(e.target.value);
              setSecondsError(undefined);
            }}
          />
        </div>
        <Checkbox
          label="Pause the watcher"
          description="No checks until you turn it back on. Check now still works."
          checked={paused}
          onCheckedChange={(on) => setPaused(on === true)}
        />
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <Fact label="Last check">
            <span style={MONO} className="text-code">
              {lastCheck}
            </span>
          </Fact>
          {view.lastError ? (
            <Fact label="Last error">
              <span className="text-danger">{view.lastError}</span>
            </Fact>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            loading={busy === 'watch'}
            disabled={pending && busy !== 'watch'}
          >
            Save
          </Button>
          {view.ready ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={checkNow}
              loading={busy === 'check'}
              disabled={pending && busy !== 'check'}
            >
              Check now
            </Button>
          ) : null}
        </div>
        <NoteLine note={watchNote} />
      </form>
    </div>
  );
}
