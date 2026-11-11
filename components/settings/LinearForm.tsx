'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Button } from '@/components/ui/Button';
import {
  checkLinearAction,
  linearOptionsAction,
  removeLinearKeyAction,
  saveLinearKeyAction,
  saveLinearMappingAction,
  saveWatcherAction,
} from '@/app/(shell)/settings/actions';
import { clockTime } from '@/lib/home-util';
import { pipelineStates, type PipelineState, type TrackerTeam } from '@/lib/schemas';
import type { LinearView, TrackerState } from '@/lib/tracker';
import { PIPELINE_HINTS, PIPELINE_LABELS } from '@/lib/tracker/labels';

type Props = {
  initial: LinearView;
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
 * Settings → Linear (D38): the API key, pasted once and never shown again; the team, the label
 * and the six pipeline states mapped onto the team's statuses and read back from Linear when
 * saved; and the watcher's pace, with the last check and Check now. Each part saves on its own.
 */
export function LinearForm({ initial, disabledReason }: Props) {
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

  // the mapping
  const [editing, setEditing] = useState(false);
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [states, setStates] = useState<TrackerState[]>([]);
  const [teamId, setTeamId] = useState(initial.team?.id ?? '');
  const [label, setLabel] = useState(initial.label?.name ?? 'magpipe');
  const [map, setMap] = useState<Record<PipelineState, string>>(
    () =>
      Object.fromEntries(pipelineStates.map((p) => [p, initial.states[p]?.id ?? ''])) as Record<
        PipelineState,
        string
      >,
  );
  const [mapNote, setMapNote] = useState<Note>(null);

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

  if (disabledReason) {
    return <p className="text-caption text-mute">{disabledReason}</p>;
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
      setTeams(res.teams);
      setKeyNote({
        tone: 'done',
        text: `Saved. Linear knows this key as ${res.view.viewer}; it sees ${res.teams.length === 1 ? 'one team' : `${res.teams.length} teams`}.`,
      });
      router.refresh();
    });
  }

  function removeKey() {
    run('remove', async () => {
      const res = await removeLinearKeyAction();
      if (!res.ok) return setKeyNote({ tone: 'error', text: res.message });
      setView(res.view);
      setEditing(false);
      setKeyNote({ tone: 'done', text: 'Removed. The mapping stays for the next key.' });
      router.refresh();
    });
  }

  async function loadTeam(id: string) {
    const res = await linearOptionsAction(id || undefined);
    if (!res.ok) {
      setMapNote({ tone: 'error', text: res.message });
      return false;
    }
    setTeams(res.teams);
    setStates(res.states);
    // A team chosen now gets the first guess; the saved team keeps its mapping.
    if (res.suggested && id !== view.team?.id) setMap(res.suggested);
    return true;
  }

  function openMapping() {
    run('open', async () => {
      setMapNote(null);
      const first = teamId || '';
      if (await loadTeam(first)) setEditing(true);
    });
  }

  function chooseTeam(id: string) {
    setTeamId(id);
    run('team', async () => {
      await loadTeam(id);
    });
  }

  function saveMapping(e: FormEvent) {
    e.preventDefault();
    run('map', async () => {
      const res = await saveLinearMappingAction({ teamId, label, states: map });
      if (!res.ok) {
        setMapNote({ tone: 'error', text: res.message });
        return;
      }
      setView(res.view);
      setEditing(false);
      setMapNote({
        tone: 'done',
        text: `Read back from Linear: ${res.statuses} statuses in ${res.view.team?.name}, and the label ${res.view.label?.name}${res.labelCreated ? ', made just now' : ''}.`,
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
              text: `Checked: ${c.issues === 1 ? 'one issue' : `${c.issues} issues`} with the label changed since the last check, ${c.changed} moved.`,
            }
          : c.status === 'error'
            ? { tone: 'error', text: c.message }
            : {
                tone: 'error',
                text:
                  c.reason === 'busy'
                    ? 'A check is already running.'
                    : 'Save a key and the mapping first.',
              },
      );
      router.refresh();
    });
  }

  const stateOptions = states.map((s) => ({ value: s.id, label: s.name }));
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
      {/* The key */}
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">API key</h3>
        {view.hasKey && !replacing ? (
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
          <form onSubmit={saveKey} noValidate className="flex flex-col gap-3">
            <Input
              id={`${ids}-key`}
              label="Personal API key"
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
        )}
        <NoteLine note={keyNote} />
      </div>

      {/* The mapping */}
      <div className="flex flex-col gap-3">
        <h3 className="font-medium text-body text-ink">Team, label and statuses</h3>
        {!view.hasKey ? (
          <p className="max-w-[31rem] text-body-sm text-body">
            Save a key first: the teams and their statuses come from Linear.
          </p>
        ) : editing ? (
          <form onSubmit={saveMapping} noValidate className="flex flex-col gap-4">
            <Select
              label="Team"
              placeholder="Pick a team"
              options={teams.map((x) => ({ value: x.id, label: `${x.name} (${x.key})` }))}
              value={teamId}
              onValueChange={chooseTeam}
              disabled={pending}
            />
            <Input
              id={`${ids}-label`}
              label="Label"
              description="Marks the issues the factory owns; Magpipe touches no other issue. Made in Linear if the team has none by this name."
              value={label}
              readOnly={pending}
              onChange={(e) => setLabel(e.target.value)}
            />
            {teamId ? (
              <div className="grid gap-4 wide:grid-cols-2 wide:items-start">
                {pipelineStates.map((p) => (
                  <Select
                    key={p}
                    label={PIPELINE_LABELS[p]}
                    description={PIPELINE_HINTS[p]}
                    placeholder="Pick a status"
                    options={stateOptions}
                    value={map[p]}
                    onValueChange={(v) => setMap((m) => ({ ...m, [p]: v }))}
                    disabled={pending}
                  />
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={busy === 'map'}
                disabled={!teamId || (pending && busy !== 'map')}
              >
                Save and read back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            {view.team ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <Fact label="Team">
                  {view.team.name} <span className="text-mute">({view.team.key})</span>
                </Fact>
                <Fact label="Label">{view.label?.name ?? 'none'}</Fact>
                {pipelineStates.map((p) => (
                  <Fact key={p} label={PIPELINE_LABELS[p]}>
                    {view.states[p]?.name ?? <span className="text-mute">not mapped</span>}
                  </Fact>
                ))}
              </dl>
            ) : (
              <p className="max-w-[31rem] text-body-sm text-body">
                Pick the team, the label and which of its statuses each stage is. Until then, specs
                stay in Magpipe.
              </p>
            )}
            <div>
              <Button
                size="sm"
                onClick={openMapping}
                loading={busy === 'open'}
                disabled={pending && busy !== 'open'}
              >
                {view.team ? 'Change the mapping' : 'Map the statuses'}
              </Button>
            </div>
          </>
        )}
        <NoteLine note={mapNote} />
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
