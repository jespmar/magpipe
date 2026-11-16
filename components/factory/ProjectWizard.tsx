'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { Badge } from '@/components/arc/badge/badge';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Input } from '@/components/arc/input/input';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { Stepper } from '@/components/arc/stepper/stepper';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button, ButtonLink } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/SearchInput';
import {
  projectLinearOptionsAction,
  saveProjectAction,
  wizardCheckFolderAction,
  wizardEnsureCloneAction,
  wizardEnsureLinearProjectAction,
  wizardEnsureRepositoryAction,
  wizardGitHubAction,
  wizardRepoScriptsAction,
} from '@/app/(shell)/factory/actions';
import type { ForgeOwner, ForgeRepo } from '@/lib/forge/types';
import type { FolderCheck } from '@/lib/project-wizard';
import {
  pipelineStates,
  type PipelineState,
  type TrackerRef,
  type TrackerTeam,
} from '@/lib/schemas';
import type { TrackerState } from '@/lib/tracker';
import { PIPELINE_HINTS, PIPELINE_LABELS } from '@/lib/tracker/labels';

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/** Scripts the Test Agent usually runs, ticked when the repository has them. */
const USUAL_SCRIPTS = ['test', 'lint', 'typecheck'];

/** How many repositories the list shows at once; search narrows the rest. */
const SHOWN = 60;

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

type Props = {
  /** Where a clone goes unless the operator picks elsewhere. */
  parentFolder: string;
  /** The factory's agents are there; else they are installed with this project (D50). */
  factoryInstalled: boolean;
  /** The shared keys in Settings: the wizard reads GitHub and Linear with them. */
  hasGithubKey: boolean;
  hasLinearKey: boolean;
  /** What other projects already hold: repositories (lower case) and Linear projects, by name. */
  takenRepos: Record<string, string>;
  takenLinear: Record<string, string>;
};

type Task = {
  id: 'repo' | 'clone' | 'linear' | 'save';
  label: string;
  /** The inputs it runs with: a finished task is kept on a try again only while they hold. */
  key: string;
  state: 'todo' | 'running' | 'done' | 'failed';
  note?: string;
  /** What it made that a later task needs: the new Linear project's id. */
  result?: string;
};

const STEPS = [
  { id: 'repo', label: 'Repository', description: 'On GitHub' },
  { id: 'folder', label: 'Folder', description: 'On this computer' },
  { id: 'linear', label: 'Linear', description: 'Where specs are filed' },
  { id: 'details', label: 'Details', description: 'Name, scripts, brief' },
  { id: 'create', label: 'Create', description: 'Check and make it' },
];

/** Which step a refusal from saving points at. */
const FIELD_STEP: Record<string, number> = {
  github: 0,
  folder: 1,
  repoPath: 1,
  linear: 2,
  name: 3,
  scripts: 3,
  context: 3,
};

/** The system's folder picker in the desktop app; in a browser, the path is typed. */
function FolderField({
  id,
  label,
  description,
  value,
  onChange,
  error,
  readOnly,
  title,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  readOnly: boolean;
  title: string;
}) {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(Boolean(window.magpipeDesktop?.pickFolder)), []);
  async function choose() {
    const picked = await window.magpipeDesktop?.pickFolder({
      title,
      defaultPath: value || undefined,
      buttonLabel: 'Choose',
    });
    if (picked) onChange(picked);
  }
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Input
          id={id}
          label={label}
          description={description}
          spellCheck={false}
          autoComplete="off"
          style={MONO}
          value={value}
          readOnly={readOnly}
          error={error}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {desktop ? (
        <div className={error ? 'mb-7' : 'mb-0.5'}>
          <Button size="sm" onClick={() => void choose()} disabled={readOnly}>
            Choose…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The New project wizard (D49): a GitHub repository picked from the account's own and its
 * organizations', or a new one; the folder it is cloned into, or one that holds it already; the
 * Linear project specs are filed in, picked or made; a name, the scripts and a brief. Nothing is
 * made until the last step, which makes what is new, then saves the project and reads it back.
 */
export function ProjectWizard({
  parentFolder,
  factoryInstalled,
  hasGithubKey,
  hasLinearKey,
  takenRepos,
  takenLinear,
}: Props) {
  const router = useRouter();
  const ids = useId();
  const [step, setStep] = useState(0);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ step: number; text: string } | null>(null);

  // 1. Repository.
  const [github, setGithub] = useState<{
    login: string;
    owners: ForgeOwner[];
    repos: ForgeRepo[];
  } | null>(null);
  const [repoMode, setRepoMode] = useState<'pick' | 'create'>('pick');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState('');
  const [owner, setOwner] = useState('');
  const [newName, setNewName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState('');

  // 2. Folder.
  const [folderMode, setFolderMode] = useState<'clone' | 'existing'>('clone');
  const [parent, setParent] = useState(parentFolder);
  const [folderName, setFolderName] = useState('');
  const [existing, setExisting] = useState('');
  const [folder, setFolder] = useState<FolderCheck | null>(null);

  // 3. Linear.
  const [teams, setTeams] = useState<TrackerTeam[] | null>(null);
  const [teamId, setTeamId] = useState('');
  const [states, setStates] = useState<TrackerState[]>([]);
  const [linearProjects, setLinearProjects] = useState<TrackerRef[]>([]);
  const [linearMode, setLinearMode] = useState<'pick' | 'create'>('pick');
  const [linearPick, setLinearPick] = useState('');
  const [linearName, setLinearName] = useState('');
  const [label, setLabel] = useState('magpipe');
  const [map, setMap] = useState<Record<PipelineState, string>>(
    () => Object.fromEntries(pipelineStates.map((p) => [p, ''])) as Record<PipelineState, string>,
  );
  const [showStates, setShowStates] = useState(false);

  // 4. Details.
  const [name, setName] = useState('');
  const [available, setAvailable] = useState<string[] | null | undefined>(undefined);
  const [scripts, setScripts] = useState<string[]>([]);
  const [context, setContext] = useState('');

  // 5. Create.
  const [tasks, setTasks] = useState<Task[] | null>(null);

  const creating = repoMode === 'create';
  const repo = creating ? `${owner}/${newName.trim()}` : picked;
  const repoShort = creating ? newName.trim() : (picked.split('/')[1] ?? '');
  const cloning = creating || folderMode === 'clone';

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

  const fail = (text: string, at = step) => setError({ step: at, text });

  /** The repositories and owners, read when the wizard opens and again on Try again. */
  function loadGitHub() {
    run('github', async () => {
      const res = await wizardGitHubAction();
      if (!res.ok) return fail(res.message, 0);
      setError(null);
      setGithub({ login: res.login, owners: res.owners, repos: res.repos });
      setOwner((o) => o || res.login);
    });
  }
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !hasGithubKey) return;
    opened.current = true;
    loadGitHub();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first render
  }, []);

  function loadTeam(id: string) {
    run('teams', async () => {
      const res = await projectLinearOptionsAction(null, id || undefined);
      if (!res.ok) return fail(res.message, 2);
      setTeams(res.teams);
      setStates(res.states);
      setLinearProjects(res.projects);
      if (id) {
        if (res.suggested) setMap(res.suggested);
        setLinearPick('');
        setLinearMode(res.projects.some((p) => !takenLinear[p.id]) ? 'pick' : 'create');
      } else if (res.teams.length === 1) {
        // One team: chosen for the operator.
        setTeamId(res.teams[0]!.id);
        const one = await projectLinearOptionsAction(null, res.teams[0]!.id);
        if (!one.ok) return fail(one.message, 2);
        setStates(one.states);
        setLinearProjects(one.projects);
        if (one.suggested) setMap(one.suggested);
        setLinearMode(one.projects.some((p) => !takenLinear[p.id]) ? 'pick' : 'create');
      }
    });
  }

  function go(to: number) {
    setError(null);
    setStep(to);
    if (to === 2 && teams === null && hasLinearKey) loadTeam('');
    if (to === 3 && available === undefined) loadScripts();
  }

  function loadScripts() {
    const choose = (list: string[] | null) => {
      setAvailable(list);
      // Choices the operator made that the new list still has stay; else the usual ones.
      setScripts((was) => {
        const kept = was.filter((s) => list?.includes(s));
        return kept.length ? kept : (list ?? []).filter((s) => USUAL_SCRIPTS.includes(s));
      });
    };
    if (folder?.scripts) return choose(folder.scripts);
    if (creating) return choose(null);
    run('scripts', async () => {
      const res = await wizardRepoScriptsAction(repo);
      // Not fatal: the scripts can be named on the project's settings later.
      choose(res.ok ? res.scripts : null);
    });
  }

  // The names filled in from the repository follow it until the operator writes their own.
  const filledFrom = useRef<{ short: string; repo: string }>({ short: '', repo: '' });

  /** Each step's own check before the next; the folder step asks the server. */
  function next() {
    setError(null);
    if (step === 0) {
      if (!creating) {
        if (!picked) return fail('Pick a repository, or make a new one.');
        if (takenRepos[picked.toLowerCase()]) {
          return fail(`${takenRepos[picked.toLowerCase()]} already lands in ${picked}.`);
        }
      } else {
        if (!owner) return fail('Pick who owns the new repository.');
        if (!REPO_NAME.test(newName.trim()) || ['.', '..'].includes(newName.trim())) {
          return fail('Name the repository with letters, digits, dots, dashes or underscores.');
        }
        const there = github?.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase());
        if (there) return fail(`${there.fullName} is already on GitHub. Pick it from the list.`);
        if (takenRepos[repo.toLowerCase()]) {
          return fail(`${takenRepos[repo.toLowerCase()]} already lands in ${repo}.`);
        }
      }
      const was = filledFrom.current;
      const follow = (v: string) => v === '' || v === was.short;
      if (follow(folderName)) setFolderName(repoShort);
      if (follow(linearName)) setLinearName(repoShort);
      if (follow(name)) setName(repoShort);
      // A different repository: what the later steps read from it is read again.
      if (was.repo !== `${repoMode}:${repo}`) {
        setFolder(null);
        setAvailable(undefined);
      }
      filledFrom.current = { short: repoShort, repo: `${repoMode}:${repo}` };
      return go(1);
    }
    if (step === 1) {
      const input = cloning
        ? { mode: 'clone' as const, repo, parent, folder: folderName }
        : { mode: 'existing' as const, repo, path: existing };
      return run('folder', async () => {
        const res = await wizardCheckFolderAction(input);
        if (!res.ok) return fail(res.message, 1);
        if (res.folder.path !== folder?.path || res.folder.state !== folder?.state) {
          setAvailable(undefined);
        }
        setFolder(res.folder);
        setStep(2);
        if (teams === null && hasLinearKey) loadTeam('');
      });
    }
    if (step === 2) {
      if (!teamId) return fail('Pick the Linear team.');
      if (linearMode === 'pick') {
        if (!linearPick) return fail('Pick a Linear project, or make a new one.');
        if (takenLinear[linearPick]) {
          return fail(`${takenLinear[linearPick]} already files into that Linear project.`);
        }
      } else {
        const wanted = linearName.trim();
        if (!wanted) return fail('Name the new Linear project.');
        if (wanted.length > 80) return fail('Keep the Linear project’s name under 80 characters.');
        const there = linearProjects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
        if (there) {
          return fail(`The team has a Linear project named ${there.name}. Pick it instead.`);
        }
      }
      if (!label.trim()) return fail('Name the label that marks factory issues.');
      const missing = pipelineStates.filter((p) => !map[p]);
      if (missing.length) {
        setShowStates(true);
        return fail(`Map every status: ${missing.map((p) => PIPELINE_LABELS[p]).join(', ')}.`);
      }
      const twice = pipelineStates.find((p, i) =>
        pipelineStates.slice(0, i).some((q) => map[q] === map[p]),
      );
      if (twice) {
        const first = pipelineStates.find((q) => map[q] === map[twice])!;
        const status = states.find((s) => s.id === map[twice])?.name ?? 'one status';
        setShowStates(true);
        return fail(
          `${PIPELINE_LABELS[first]} and ${PIPELINE_LABELS[twice]} both use ${status}. Each needs its own.`,
        );
      }
      return go(3);
    }
    if (step === 3) {
      if (!name.trim()) return fail('Give the project a name.');
      if (context.length > 4000) return fail('Keep the brief under 4000 characters.');
      return go(4);
    }
  }

  const linearChoice =
    linearMode === 'pick'
      ? (linearProjects.find((p) => p.id === linearPick)?.name ?? '')
      : linearName.trim();
  const team = teams?.find((t) => t.id === teamId);

  /**
   * The tasks for what is chosen now. Each carries the inputs it runs with, so a try again keeps
   * a finished task only when nothing it used has changed since.
   */
  function plan(): Task[] {
    const task = (id: Task['id'], label: string, inputs: unknown): Task => ({
      id,
      label,
      key: JSON.stringify(inputs),
      state: 'todo',
    });
    return [
      ...(creating
        ? [task('repo', `Make ${repo} on GitHub`, [repo, isPrivate, description.trim()])]
        : []),
      ...(cloning
        ? [
            task('clone', `Clone ${repo} into ${folder?.path ?? folderName}`, [
              repo,
              parent,
              folderName,
            ]),
          ]
        : []),
      ...(linearMode === 'create'
        ? [
            task(
              'linear',
              `Make the Linear project ${linearChoice} in ${team?.name ?? 'the team'}`,
              [teamId, linearChoice],
            ),
          ]
        : []),
      task(
        'save',
        factoryInstalled
          ? 'Save the project and read it back'
          : 'Save the project, read it back and install the factory’s agents',
        null,
      ),
    ];
  }

  /** Makes what is new, in order, then saves. A failed task stops it; trying again resumes. */
  function create() {
    setError(null);
    const list = plan().map((t) => {
      const before = tasks?.find((b) => b.id === t.id && b.key === t.key && b.state === 'done');
      return before && t.id !== 'save' ? before : t;
    });
    setTasks(list);
    const update = (id: Task['id'], patch: Partial<Task>) =>
      setTasks((ts) => ts?.map((t) => (t.id === id ? { ...t, ...patch } : t)) ?? null);
    run('create', async () => {
      const repoPath = folder?.path ?? existing;
      let linearProjectId =
        linearMode === 'create' ? (list.find((t) => t.id === 'linear')?.result ?? '') : linearPick;
      for (const task of list) {
        if (task.state === 'done') continue;
        update(task.id, { state: 'running', note: undefined });
        let res:
          | { ok: true; note: string; result?: string }
          | { ok: false; message: string; field?: string };
        if (task.id === 'repo') {
          const r = await wizardEnsureRepositoryAction({
            owner,
            name: newName.trim(),
            private: isPrivate,
            description,
          });
          res = r.ok
            ? { ok: true, note: r.created ? 'Made.' : 'Already on GitHub, used as it is.' }
            : r;
        } else if (task.id === 'clone') {
          const r = await wizardEnsureCloneAction({ repo, parent, folder: folderName });
          res = r.ok ? { ok: true, note: r.reused ? 'The folder had it already.' : 'Cloned.' } : r;
        } else if (task.id === 'linear') {
          const r = await wizardEnsureLinearProjectAction({ teamId, name: linearChoice });
          if (r.ok) linearProjectId = r.project.id;
          res = r.ok
            ? {
                ok: true,
                note: r.created ? 'Made.' : 'Already in Linear, used as it is.',
                result: r.project.id,
              }
            : r;
        } else {
          const r = await saveProjectAction(null, {
            name: name.trim(),
            repoPath,
            scripts: scripts.join(', '),
            context,
            linear: { teamId, projectId: linearProjectId, label: label.trim(), states: map },
            github: {
              repo,
              mergeMethod: 'squash',
              autoMerge: false,
              autoMergeLabel: 'auto-merge',
              autoMergeFirstPass: true,
              autoMergeChecks: true,
            },
            maxRuns: null,
            spendCapUsd: null,
            models: {},
          });
          if (r.ok) {
            update('save', { state: 'done', note: r.notes.join(' ') });
            router.replace(`/factory/${r.project.id}`, { scroll: false });
            return;
          }
          res = r;
        }
        if (!res.ok) {
          update(task.id, { state: 'failed', note: res.message });
          const at = res.field ? FIELD_STEP[res.field] : undefined;
          fail(
            at !== undefined && at < 4
              ? `${res.message} Fix it in ${STEPS[at]!.label}, then create again.`
              : res.message,
            4,
          );
          return;
        }
        update(task.id, { state: 'done', note: res.note, result: res.result });
      }
    });
  }

  const busyCreating = busy === 'create';

  // ─── the steps ───────────────────────────────────────────────────────────

  const shownRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = github?.repos ?? [];
    const match = q
      ? all.filter(
          (r) =>
            r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q),
        )
      : all;
    return { total: match.length, list: match.slice(0, SHOWN) };
  }, [github, query]);

  const byOwner = useMemo(() => {
    const groups = new Map<string, ForgeRepo[]>();
    for (const r of shownRepos.list) groups.set(r.owner, [...(groups.get(r.owner) ?? []), r]);
    // The account's own first, then organizations by name.
    return [...groups.entries()].sort(([a], [b]) =>
      a === github?.login ? -1 : b === github?.login ? 1 : a.localeCompare(b),
    );
  }, [shownRepos, github]);

  const repoStep = !hasGithubKey ? (
    <p className="max-w-[31rem] text-body-sm text-body">
      Connect GitHub in Settings first: use the GitHub CLI’s sign-in or paste a token. The
      repositories come from your account.{' '}
      <a className="text-ink underline" href="/settings#github">
        Open Settings
      </a>
    </p>
  ) : (
    <div className="flex flex-col gap-5">
      <SegmentedControl
        className="self-start"
        label="Repository"
        options={[
          { value: 'pick', label: 'Pick a repository' },
          { value: 'create', label: 'Make a new one' },
        ]}
        value={repoMode}
        onValueChange={(v) => {
          setRepoMode(v as 'pick' | 'create');
          setError(null);
        }}
      />
      {!github && busy !== 'github' ? (
        <div>
          <Button size="sm" onClick={loadGitHub} disabled={pending}>
            Read the repositories again
          </Button>
        </div>
      ) : null}
      {repoMode === 'pick' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SearchInput
              label="Search repositories"
              placeholder="Search repositories"
              value={query}
              onChange={setQuery}
              className="w-[320px]"
            />
            <p className="text-caption text-mute">
              {github
                ? `${github.repos.length} you can push to, as ${github.login}`
                : busy === 'github'
                  ? 'Reading your repositories from GitHub…'
                  : ''}
            </p>
          </div>
          {github ? (
            <div
              role="radiogroup"
              aria-label="Repositories"
              className="flex max-h-[30rem] flex-col gap-5 overflow-y-auto rounded-(--radius-control) border border-hairline p-3"
            >
              {byOwner.length === 0 ? (
                <p className="text-body-sm text-body">
                  {query ? `No repository matches “${query}”.` : 'No repositories you can push to.'}
                </p>
              ) : null}
              {byOwner.map(([who, list]) => (
                <div key={who} className="flex flex-col gap-1">
                  <h3 className="px-2 text-caption text-mute">
                    {who}
                    {who === github.login ? ' (you)' : ''}
                  </h3>
                  {list.map((r) => {
                    const taken = takenRepos[r.fullName.toLowerCase()];
                    return (
                      <label
                        key={r.fullName}
                        className={`flex cursor-pointer items-start gap-3 rounded-(--radius-control) border px-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color-mix(in_oklab,var(--accent-strong)_72%,transparent)] ${
                          picked === r.fullName
                            ? 'border-cyan bg-cyan-soft'
                            : 'border-transparent hover:bg-canvas-raised'
                        } ${taken ? 'cursor-not-allowed opacity-60' : ''}`}
                      >
                        <input
                          type="radio"
                          name={`${ids}-repo`}
                          aria-label={`${r.fullName}, ${r.private ? 'private' : 'public'}${taken ? `, used by ${taken}` : ''}`}
                          aria-describedby={r.description ? `${ids}-d-${r.fullName}` : undefined}
                          value={r.fullName}
                          checked={picked === r.fullName}
                          disabled={Boolean(taken)}
                          onChange={() => {
                            setPicked(r.fullName);
                            setError(null);
                          }}
                          className="sr-only"
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-code text-ink" style={MONO}>
                              {r.name}
                            </span>
                            <Badge size="sm">{r.private ? 'private' : 'public'}</Badge>
                            {taken ? (
                              <span className="text-caption text-mute">used by {taken}</span>
                            ) : null}
                          </span>
                          {r.description ? (
                            <span
                              id={`${ids}-d-${r.fullName}`}
                              className="truncate text-body-sm text-body"
                            >
                              {r.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
              {shownRepos.total > shownRepos.list.length ? (
                <p className="px-2 text-caption text-mute">
                  {shownRepos.total - shownRepos.list.length} more. Search to narrow them down.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:items-start">
          <Select
            label="Owner"
            placeholder="Pick an owner"
            options={(github?.owners ?? []).map((o) => ({
              value: o.login,
              label: o.kind === 'user' ? `${o.login} (you)` : o.login,
            }))}
            value={owner}
            onValueChange={setOwner}
            disabled={pending}
          />
          <Input
            id={`${ids}-new-name`}
            label="Name"
            description="Letters, digits, dots, dashes and underscores."
            spellCheck={false}
            autoComplete="off"
            style={MONO}
            value={newName}
            readOnly={pending}
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="md:col-span-2">
            <Input
              id={`${ids}-new-description`}
              label="Description"
              description="Optional. Shown on GitHub."
              value={description}
              readOnly={pending}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="md:col-span-2">
            <Checkbox
              label="Private"
              description="Only you and the people you add can see it."
              checked={isPrivate}
              onCheckedChange={(on) => setIsPrivate(on === true)}
            />
          </div>
          <p className="max-w-[31rem] text-body-sm text-body md:col-span-2">
            It is made with a README, so it has a main branch for goals to branch from. Nothing is
            made until the last step.
          </p>
        </div>
      )}
    </div>
  );

  const folderStep = (
    <div className="flex flex-col gap-5">
      {creating ? null : (
        <SegmentedControl
          className="self-start"
          label="Folder"
          options={[
            { value: 'clone', label: 'Clone it' },
            { value: 'existing', label: 'Use a folder that has it' },
          ]}
          value={folderMode}
          onValueChange={(v) => {
            setFolderMode(v as 'clone' | 'existing');
            setError(null);
          }}
        />
      )}
      {cloning ? (
        <>
          <FolderField
            id={`${ids}-parent`}
            label="Clone into"
            description="A folder on this computer. The clone goes into a new folder inside it."
            title="Clone into"
            value={parent}
            onChange={setParent}
            readOnly={pending}
          />
          <div className="max-w-[24rem]">
            <Input
              id={`${ids}-folder-name`}
              label="New folder’s name"
              spellCheck={false}
              autoComplete="off"
              style={MONO}
              value={folderName}
              readOnly={pending}
              onChange={(e) => setFolderName(e.target.value)}
            />
          </div>
          <p className="text-body-sm text-body">
            {creating ? 'The new repository' : repo} is cloned to{' '}
            <span className="text-code break-all text-ink" style={MONO}>
              {parent.replace(/[\\/]+$/, '')}
              {parent.includes('\\') && !parent.includes('/') ? '\\' : '/'}
              {folderName}
            </span>
            .
          </p>
        </>
      ) : (
        <FolderField
          id={`${ids}-existing`}
          label="Folder"
          description={`A clone of ${repo} on this computer, as an absolute path.`}
          title={`The folder that holds ${repo}`}
          value={existing}
          onChange={setExisting}
          readOnly={pending}
        />
      )}
    </div>
  );

  const takenNote = (p: TrackerRef) => (takenLinear[p.id] ? ` (used by ${takenLinear[p.id]})` : '');
  const linearStep = !hasLinearKey ? (
    <p className="max-w-[31rem] text-body-sm text-body">
      Connect Linear in Settings first: sign in with Linear or paste a key. The teams and their
      projects come from Linear.{' '}
      <a className="text-ink underline" href="/settings#linear">
        Open Settings
      </a>
    </p>
  ) : teams === null ? (
    <p className="text-body-sm text-body">Reading the teams from Linear…</p>
  ) : (
    <div className="flex flex-col gap-5">
      <div className="max-w-[24rem]">
        <Select
          label="Team"
          placeholder="Pick a team"
          options={teams.map((x) => ({ value: x.id, label: `${x.name} (${x.key})` }))}
          value={teamId}
          onValueChange={(id) => {
            setTeamId(id);
            loadTeam(id);
          }}
          disabled={pending}
        />
      </div>
      {teamId ? (
        <>
          <SegmentedControl
            className="self-start"
            label="Linear project"
            options={[
              { value: 'pick', label: 'Pick a Linear project' },
              { value: 'create', label: 'Make a new one' },
            ]}
            value={linearMode}
            onValueChange={(v) => {
              setLinearMode(v as 'pick' | 'create');
              setError(null);
            }}
          />
          <div className="max-w-[24rem]">
            {linearMode === 'pick' ? (
              <Select
                label="Linear project"
                placeholder="Pick a Linear project"
                description={
                  linearProjects.length
                    ? 'Specs and goals are filed in it; the watcher reads only its issues.'
                    : 'The team has no Linear projects yet: make one.'
                }
                options={linearProjects.map((p) => ({
                  value: p.id,
                  label: `${p.name}${takenNote(p)}`,
                  disabled: Boolean(takenLinear[p.id]),
                }))}
                value={linearPick}
                onValueChange={setLinearPick}
                disabled={pending}
              />
            ) : (
              <Input
                id={`${ids}-linear-name`}
                label="New Linear project’s name"
                description={`Made in ${team?.name ?? 'the team'} at the last step.`}
                value={linearName}
                readOnly={pending}
                onChange={(e) => setLinearName(e.target.value)}
              />
            )}
          </div>
          <div className="flex flex-col gap-3">
            <p className="max-w-[31rem] text-body-sm text-body">
              Issues carry the label <span className="text-ink">{label || 'none'}</span>, and the
              team’s statuses map onto the pipeline:{' '}
              {pipelineStates
                .map(
                  (p) =>
                    `${PIPELINE_LABELS[p]} is ${states.find((s) => s.id === map[p])?.name ?? 'not mapped'}`,
                )
                .join('; ')}
              .
            </p>
            <div>
              <Button size="sm" variant="ghost" onClick={() => setShowStates((s) => !s)}>
                {showStates ? 'Hide the label and statuses' : 'Change the label or statuses'}
              </Button>
            </div>
            {showStates ? (
              <div className="flex flex-col gap-4">
                <div className="max-w-[24rem]">
                  <Input
                    id={`${ids}-label`}
                    label="Label"
                    description="Marks the issues the factory owns. Made in Linear if the team has none by this name."
                    value={label}
                    readOnly={pending}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2 md:items-start wide:grid-cols-3">
                  {pipelineStates.map((p) => (
                    <Select
                      key={p}
                      label={PIPELINE_LABELS[p]}
                      description={PIPELINE_HINTS[p]}
                      placeholder="Pick a status"
                      options={states.map((s) => ({ value: s.id, label: s.name }))}
                      value={map[p]}
                      onValueChange={(v) => setMap((m) => ({ ...m, [p]: v }))}
                      disabled={pending}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );

  const detailsStep = (
    <div className="flex flex-col gap-5">
      <div className="max-w-[24rem]">
        <Input
          id={`${ids}-name`}
          label="Project name"
          value={name}
          readOnly={pending}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-body-sm font-medium text-ink">Scripts agents may run</legend>
        {available === undefined ? (
          <p className="text-body-sm text-body">Reading package.json…</p>
        ) : available === null || available.length === 0 ? (
          <p className="max-w-[31rem] text-body-sm text-body">
            {available === null
              ? 'The repository has no package.json yet,'
              : 'Its package.json has no scripts yet,'}{' '}
            so the Test Agent has nothing to run. Name the scripts on the project’s settings once it
            has some.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 wide:grid-cols-3">
            {available.map((s) => (
              <Checkbox
                key={s}
                label={s}
                checked={scripts.includes(s)}
                onCheckedChange={(on) =>
                  setScripts((list) => (on === true ? [...list, s] : list.filter((x) => x !== s)))
                }
              />
            ))}
          </div>
        )}
      </fieldset>
      <Textarea
        id={`${ids}-context`}
        label="Brief for the agents"
        description={`What every factory agent should know: what it is, who uses it, conventions that are not in the code. ${context.length} of 4000 characters.`}
        rows={5}
        value={context}
        readOnly={pending}
        onChange={(e) => setContext(e.target.value)}
      />
    </div>
  );

  const facts: [string, ReactNode][] = [
    [
      'Repository',
      <>
        <span style={MONO} className="text-code">
          {repo}
        </span>
        {creating ? `, new and ${isPrivate ? 'private' : 'public'}` : ''}
      </>,
    ],
    [
      'Folder',
      <span key="f" style={MONO} className="text-code break-all">
        {folder?.path ?? ''}
        {cloning ? (folder?.state === 'same' ? ' (holds it already)' : ', cloned') : ''}
      </span>,
    ],
    [
      'Linear',
      `${team?.name ?? ''}, ${linearMode === 'create' ? 'new project' : 'project'} ${linearChoice}, label ${label}`,
    ],
    ['Name', name],
    ['Scripts', scripts.length ? scripts.join(', ') : 'none yet'],
  ];

  const createStep = (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-body-sm text-mute">{k}</dt>
            <dd className="text-body-sm text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="max-w-[31rem] text-body-sm text-body">
        Limits and models start as the workspace’s, and pull requests squash and merge when you say
        so. Change any of it on the project’s settings.
        {factoryInstalled ? '' : ' The factory’s nine agents are installed with it.'}
      </p>
      {tasks ? (
        <ol aria-label="Progress" aria-live="polite" className="flex flex-col gap-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Badge
                size="sm"
                tone={
                  t.state === 'done'
                    ? 'success'
                    : t.state === 'failed'
                      ? 'danger'
                      : t.state === 'running'
                        ? 'info'
                        : 'neutral'
                }
              >
                {t.state === 'todo' ? 'next' : t.state}
              </Badge>
              <span className="text-body-sm text-ink">{t.label}</span>
              {t.note ? (
                <span
                  className={`text-body-sm ${t.state === 'failed' ? 'text-danger' : 'text-body'}`}
                >
                  {t.note}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );

  const body = [repoStep, folderStep, linearStep, detailsStep, createStep][step];
  const titles = [
    'Which repository is it?',
    'Where does it live on this computer?',
    'Where are its specs filed?',
    'What should the agents know?',
    'Check it, then create it',
  ];
  const stepError = error?.step === step ? error.text : null;
  const canContinue =
    step === 0
      ? hasGithubKey && (repoMode === 'create' || Boolean(github))
      : step === 2
        ? hasLinearKey
        : true;

  return (
    <div className="flex max-w-[72rem] flex-col gap-6">
      <Stepper
        label="New project"
        steps={STEPS.map((s, i) => ({
          ...s,
          error: error?.step === i && i !== step ? 'Needs a look' : undefined,
        }))}
        current={step}
        onStepSelect={pending ? undefined : (i) => go(i)}
        details="current"
      />
      <section aria-labelledby={`${ids}-title`} className="flex flex-col gap-6 card p-6">
        <h2 id={`${ids}-title`} className="font-medium text-body text-ink">
          {titles[step]}
        </h2>
        {body}
        <p role="status" aria-live="polite" className="text-body-sm text-danger">
          {stepError ?? ''}
        </p>
        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
          {step < 4 ? (
            <Button
              variant="primary"
              onClick={next}
              loading={busy === 'folder'}
              disabled={!canContinue || (pending && busy !== 'folder')}
            >
              Continue
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={create}
              loading={busyCreating}
              disabled={pending && !busyCreating}
            >
              {tasks?.some((t) => t.state === 'failed') ? 'Try again' : 'Create project'}
            </Button>
          )}
          {step > 0 ? (
            <Button variant="ghost" onClick={() => go(step - 1)} disabled={pending}>
              Back
            </Button>
          ) : null}
          <ButtonLink href="/factory" variant="ghost" size="md">
            Cancel
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
