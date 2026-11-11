'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import {
  deleteProjectAction,
  projectLinearOptionsAction,
  saveProjectAction,
  setProjectKeyAction,
} from '@/app/(shell)/factory/projects/actions';
import type { ProjectView } from '@/lib/projects';
import {
  mergeMethods,
  pipelineStates,
  type PipelineState,
  type ProjectInput,
  type TrackerRef,
  type TrackerTeam,
} from '@/lib/schemas';
import type { TrackerState } from '@/lib/tracker';
import { PIPELINE_HINTS, PIPELINE_LABELS } from '@/lib/tracker/labels';

type Note = { tone: 'done' | 'error'; text: string } | null;

/** A factory agent as the models section lists it. */
export type ProjectAgent = { slug: string; name: string; model: string };

type Props = {
  /** null for a new project. */
  initial: ProjectView | null;
  agents: ProjectAgent[];
  models: string[];
  /** What the workspace gives a project that sets nothing of its own. */
  workspace: {
    linear: string;
    github: string;
    maxRuns: number;
    hasLinearKey: boolean;
    hasGithubKey: boolean;
  };
};

const MONO = { fontFamily: 'var(--font-mono)' } as const;
const NONE = '__none';
const OWN = '__own';

const METHOD_LABELS: Record<(typeof mergeMethods)[number], string> = {
  squash: 'Squash and merge',
  merge: 'Merge commit',
  rebase: 'Rebase and merge',
};

function NoteLine({ note }: { note: Note }) {
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

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid gap-6 card p-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start"
    >
      <div className="flex flex-col gap-2">
        <h2 id={id} className="font-medium text-body text-ink">
          {title}
        </h2>
        <p className="max-w-[31rem] text-body-sm text-body">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * Factory → Projects → one project (D45): the repository and its scripts, a brief for the agents,
 * its own Linear team and project and its own GitHub repository (or the workspace's), limits, and
 * a model per factory agent. Saving reads back everything it names; the keys save on their own.
 */
export function ProjectForm({ initial, agents, models, workspace }: Props) {
  const router = useRouter();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [field, setField] = useState<string>();

  const [name, setName] = useState(initial?.name ?? '');
  const [repoPath, setRepoPath] = useState(initial?.repoPath ?? '');
  const [scripts, setScripts] = useState((initial?.scripts ?? ['test']).join(', '));
  const [context, setContext] = useState(initial?.context ?? '');

  // Linear: the project's own team, or the workspace's.
  const [ownLinear, setOwnLinear] = useState(initial?.linear.team != null);
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [states, setStates] = useState<TrackerState[]>([]);
  const [linearProjects, setLinearProjects] = useState<TrackerRef[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [teamId, setTeamId] = useState(initial?.linear.team?.id ?? '');
  const [linearProject, setLinearProject] = useState(initial?.linear.project?.id ?? NONE);
  const [label, setLabel] = useState(initial?.linear.label?.name ?? 'magpipe');
  const [map, setMap] = useState<Record<PipelineState, string>>(
    () =>
      Object.fromEntries(
        pipelineStates.map((p) => [p, initial?.linear.states[p]?.id ?? '']),
      ) as Record<PipelineState, string>,
  );

  // GitHub: the project's own repository, or the workspace's.
  const gh = initial?.github;
  const [ownGithub, setOwnGithub] = useState(gh?.repo != null);
  const [repo, setRepo] = useState(gh?.repo ?? '');
  const [method, setMethod] = useState<ProjectInput['github']['mergeMethod']>(
    gh?.mergeMethod ?? 'squash',
  );
  const [auto, setAuto] = useState(gh?.autoMerge ?? false);
  const [autoLabel, setAutoLabel] = useState(gh?.autoMergeLabel ?? 'auto-merge');
  const [firstPass, setFirstPass] = useState(gh?.autoMergeFirstPass ?? true);
  const [checks, setChecks] = useState(gh?.autoMergeChecks ?? true);

  const [maxRuns, setMaxRuns] = useState(initial?.maxRuns ? String(initial.maxRuns) : '');
  const [cap, setCap] = useState(initial?.spendCapUsd ? String(initial.spendCapUsd) : '');
  const [picked, setPicked] = useState<Record<string, string>>(initial?.models ?? {});

  // The keys, on a saved project only.
  const [linearKey, setLinearKey] = useState('');
  const [githubKey, setGithubKey] = useState('');
  const [keyNote, setKeyNote] = useState<Note>(null);
  const [confirming, setConfirming] = useState(false);

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

  async function loadTeam(id: string) {
    const res = await projectLinearOptionsAction(view?.id ?? null, id || undefined);
    if (!res.ok) {
      setNote({ tone: 'error', text: res.message });
      setField('linear');
      return false;
    }
    setTeams(res.teams);
    setStates(res.states);
    setLinearProjects(res.projects);
    setLoaded(true);
    if (res.suggested && id !== view?.linear.team?.id) {
      setMap(res.suggested);
      setLinearProject(NONE);
    }
    return true;
  }

  function toggleOwnLinear(on: boolean) {
    setOwnLinear(on);
    if (on && !loaded) run('teams', async () => void (await loadTeam(teamId)));
  }

  function chooseTeam(id: string) {
    setTeamId(id);
    run('team', async () => void (await loadTeam(id)));
  }

  function number(text: string): number | null {
    return text.trim() === '' ? null : Number(text);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const input: ProjectInput = {
      name,
      repoPath,
      scripts,
      context,
      linear: ownLinear
        ? {
            teamId,
            projectId: linearProject === NONE ? '' : linearProject,
            label,
            states: map,
          }
        : { teamId: '', projectId: '', label: '', states: {} },
      github: {
        repo: ownGithub ? repo : '',
        mergeMethod: method,
        autoMerge: auto,
        autoMergeLabel: autoLabel,
        autoMergeFirstPass: firstPass,
        autoMergeChecks: checks,
      },
      maxRuns: number(maxRuns),
      spendCapUsd: number(cap),
      models: picked,
    };
    run('save', async () => {
      const res = await saveProjectAction(view?.id ?? null, input);
      if (!res.ok) {
        setNote({ tone: 'error', text: res.message });
        setField(res.field);
        return;
      }
      setField(undefined);
      setNote({ tone: 'done', text: ['Saved.', ...res.notes].join(' ') });
      if (!view) {
        router.replace(`/factory/projects/${res.project.id}`, { scroll: false });
        return;
      }
      setView(res.project);
      router.refresh();
    });
  }

  function saveKey(kind: 'linear' | 'github', key: string | null) {
    if (!view) return;
    run(`${kind}-key`, async () => {
      const res = await setProjectKeyAction(view.id, kind, key);
      if (!res.ok) return setKeyNote({ tone: 'error', text: res.message });
      setView(res.project);
      if (kind === 'linear') setLinearKey('');
      else setGithubKey('');
      setKeyNote({
        tone: 'done',
        text: key
          ? `Saved. ${kind === 'linear' ? 'Linear' : 'GitHub'} knows it as ${res.who}.`
          : `Removed. The project uses the workspace’s ${kind === 'linear' ? 'Linear key' : 'GitHub token'} again.`,
      });
      setLoaded(false);
      router.refresh();
    });
  }

  function remove() {
    if (!view) return;
    run('delete', async () => {
      const res = await deleteProjectAction(view.id);
      if (!res.ok) return setNote({ tone: 'error', text: res.message });
      router.replace('/factory/projects');
    });
  }

  const err = (f: string) => (field === f && note?.tone === 'error' ? note.text : undefined);
  const stateOptions = states.map((s) => ({ value: s.id, label: s.name }));
  const modelOptions = (own: string) => [
    { value: OWN, label: `The agent’s own (${own})` },
    ...models.map((m) => ({ value: m, label: m })),
  ];

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-6">
      <Section
        title="Repository"
        description="The folder the factory builds in, each goal in a worktree of its own, and the scripts the Test Agent may run."
      >
        <Input
          id={`${ids}-name`}
          label="Name"
          value={name}
          readOnly={pending}
          error={err('name')}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          id={`${ids}-path`}
          label="Folder"
          description="An absolute path to a Git repository on this computer."
          spellCheck={false}
          style={MONO}
          value={repoPath}
          readOnly={pending}
          error={err('repoPath')}
          onChange={(e) => setRepoPath(e.target.value)}
        />
        <Input
          id={`${ids}-scripts`}
          label="Scripts agents may run"
          description="From its package.json, separated by commas."
          spellCheck={false}
          style={MONO}
          value={scripts}
          readOnly={pending}
          error={err('scripts')}
          onChange={(e) => setScripts(e.target.value)}
        />
      </Section>

      <Section
        title="Context for the agents"
        description="What every factory agent should know about this project: what it is, who uses it, conventions that are not in the code. It goes into each step’s prompt."
      >
        <Textarea
          id={`${ids}-context`}
          label="Brief"
          description={`${context.length} of 4000 characters.`}
          rows={6}
          value={context}
          readOnly={pending}
          error={err('context')}
          onChange={(e) => setContext(e.target.value)}
        />
      </Section>

      <Section
        title="Linear"
        description="Where this project’s specs and goals are filed and watched. Without its own team it uses the workspace’s from Settings."
      >
        <Checkbox
          label="Use a Linear team of its own"
          description={`Off: ${workspace.linear}.`}
          checked={ownLinear}
          onCheckedChange={(on) => toggleOwnLinear(on === true)}
        />
        {ownLinear ? (
          loaded ? (
            <>
              <Select
                label="Team"
                placeholder="Pick a team"
                options={teams.map((x) => ({ value: x.id, label: `${x.name} (${x.key})` }))}
                value={teamId}
                onValueChange={chooseTeam}
                disabled={pending}
              />
              {teamId ? (
                <>
                  <Select
                    label="Linear project"
                    description="Issues are filed in it, and the watcher reads only its issues. None: the whole team."
                    options={[
                      { value: NONE, label: 'None, the whole team' },
                      ...linearProjects.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    value={linearProject}
                    onValueChange={setLinearProject}
                    disabled={pending}
                  />
                  <Input
                    id={`${ids}-label`}
                    label="Label"
                    description="Marks the issues the factory owns. Made in Linear if the team has none by this name."
                    value={label}
                    readOnly={pending}
                    onChange={(e) => setLabel(e.target.value)}
                  />
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
                </>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col gap-3">
              {view?.linear.team ? (
                <p className="text-body-sm text-body">
                  {view.linear.team.name}
                  {view.linear.project ? `, project ${view.linear.project.name}` : ''}, label{' '}
                  {view.linear.label?.name}. Statuses:{' '}
                  {pipelineStates
                    .map(
                      (p) =>
                        `${PIPELINE_LABELS[p]}: ${view.linear.states[p]?.name ?? 'not mapped'}`,
                    )
                    .join('; ')}
                  .
                </p>
              ) : null}
              <div>
                <Button
                  size="sm"
                  onClick={() => run('teams', async () => void (await loadTeam(teamId)))}
                  loading={busy === 'teams'}
                  disabled={pending && busy !== 'teams'}
                >
                  {view?.linear.team ? 'Change the team or statuses' : 'Read the teams from Linear'}
                </Button>
              </div>
            </div>
          )
        ) : null}
        {err('linear') ? <p className="text-body-sm text-danger">{err('linear')}</p> : null}
      </Section>

      <Section
        title="GitHub"
        description="Where this project’s pull requests open and merge, and whether they may merge without asking. Without its own repository it uses the workspace’s."
      >
        <Checkbox
          label="Use a repository of its own"
          description={`Off: ${workspace.github}.`}
          checked={ownGithub}
          onCheckedChange={(on) => setOwnGithub(on === true)}
        />
        {ownGithub ? (
          <>
            <Input
              id={`${ids}-repo`}
              label="Repository"
              description="As owner/name. Read back from GitHub when you save."
              autoComplete="off"
              spellCheck={false}
              style={MONO}
              value={repo}
              readOnly={pending}
              onChange={(e) => setRepo(e.target.value)}
            />
            <Select
              label="How pull requests merge"
              options={mergeMethods.map((m) => ({ value: m, label: METHOD_LABELS[m] }))}
              value={method}
              onValueChange={(v) => setMethod(v as ProjectInput['github']['mergeMethod'])}
              disabled={pending}
            />
            <Checkbox
              label="Merge without asking when the rule holds"
              description="Off unless you turn it on. The goal is still brought up to date, tested again and checked before it merges."
              checked={auto}
              onCheckedChange={(on) => setAuto(on === true)}
            />
            <div className="max-w-[20rem]">
              <Input
                id={`${ids}-auto-label`}
                label="Label it needs"
                description="On the goal or its spec in Linear."
                autoComplete="off"
                spellCheck={false}
                value={autoLabel}
                readOnly={pending}
                onChange={(e) => setAutoLabel(e.target.value)}
              />
            </div>
            <Checkbox
              label="Only when every judge passed on the first try"
              checked={firstPass}
              onCheckedChange={(on) => setFirstPass(on === true)}
            />
            <Checkbox
              label="Only when the pull request’s checks are green"
              checked={checks}
              onCheckedChange={(on) => setChecks(on === true)}
            />
          </>
        ) : null}
        {err('github') ? <p className="text-body-sm text-danger">{err('github')}</p> : null}
      </Section>

      <Section
        title="Limits"
        description="Inside the workspace’s limits in Settings, never above them. Empty means the workspace’s."
      >
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <Input
            id={`${ids}-max`}
            label="Builds at once"
            description={`From 1 to 8. The workspace allows ${workspace.maxRuns}.`}
            type="number"
            min={1}
            max={8}
            style={MONO}
            value={maxRuns}
            readOnly={pending}
            error={err('maxRuns')}
            onChange={(e) => setMaxRuns(e.target.value)}
          />
          <Input
            id={`${ids}-cap`}
            label="Daily spend cap, in dollars"
            description="Runs of this project stop before a step once today’s spend on it reaches this."
            type="number"
            min={0}
            step="0.01"
            style={MONO}
            value={cap}
            readOnly={pending}
            error={err('spendCapUsd')}
            onChange={(e) => setCap(e.target.value)}
          />
        </div>
      </Section>

      <Section
        title="Models"
        description="A model for each factory agent on this project’s runs. The agent’s own is the one set on Agents."
      >
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start wide:grid-cols-3">
          {agents.map((a) => (
            <Select
              key={a.slug}
              label={a.name}
              options={modelOptions(a.model)}
              value={picked[a.slug] ?? OWN}
              onValueChange={(v) =>
                setPicked((m) => {
                  const next = { ...m };
                  if (v === OWN) delete next[a.slug];
                  else next[a.slug] = v;
                  return next;
                })
              }
              disabled={pending}
            />
          ))}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          loading={busy === 'save'}
          disabled={pending && busy !== 'save'}
        >
          {view ? 'Save and read back' : 'Create project'}
        </Button>
        {view ? (
          confirming ? (
            <>
              <Button
                variant="ghost"
                onClick={remove}
                loading={busy === 'delete'}
                disabled={pending && busy !== 'delete'}
              >
                Delete, keeping its issues
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(true)} disabled={pending}>
              Delete project
            </Button>
          )
        ) : null}
      </div>
      <NoteLine note={note} />

      {view ? (
        <Section
          title="Keys of its own"
          description="Only when this project lives in another Linear workspace or GitHub account. Checked before they are stored, encrypted, never shown again."
        >
          <div className="grid gap-6 md:grid-cols-2 md:items-start">
            {(['linear', 'github'] as const).map((kind) => {
              const has = kind === 'linear' ? view.hasLinearKey : view.hasGithubKey;
              const hint = kind === 'linear' ? view.linearKeyHint : view.githubKeyHint;
              const value = kind === 'linear' ? linearKey : githubKey;
              const fallback = kind === 'linear' ? workspace.hasLinearKey : workspace.hasGithubKey;
              return (
                <div key={kind} className="flex flex-col gap-3">
                  <h3 className="text-body-sm font-medium text-ink">
                    {kind === 'linear' ? 'Linear key' : 'GitHub token'}
                  </h3>
                  <p className="text-body-sm text-body">
                    {has ? (
                      <>
                        Its own, ending in{' '}
                        <span style={MONO} className="text-code">
                          {hint}
                        </span>
                        .
                      </>
                    ) : fallback ? (
                      'The workspace’s, from Settings.'
                    ) : (
                      'None yet: Settings has none either.'
                    )}
                  </p>
                  <Input
                    id={`${ids}-${kind}-key`}
                    label={has ? 'Replace it' : 'Its own'}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    readOnly={pending}
                    onChange={(e) =>
                      kind === 'linear'
                        ? setLinearKey(e.target.value)
                        : setGithubKey(e.target.value)
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => saveKey(kind, value)}
                      loading={busy === `${kind}-key`}
                      disabled={pending && busy !== `${kind}-key`}
                    >
                      Save {kind === 'linear' ? 'key' : 'token'}
                    </Button>
                    {has ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => saveKey(kind, null)}
                        disabled={pending}
                      >
                        Use the workspace’s
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <NoteLine note={keyNote} />
        </Section>
      ) : null}
    </form>
  );
}
