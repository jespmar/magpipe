/**
 * What steps did in bound repositories (D29): the items repository tools report as they run,
 * folded into a step's record, said back as facts in later prompts (and to the step itself when a
 * restart interrupted it, D33), summed up for the flight path
 * and gathered into the run's artefacts. Pure and client-safe; tested in tests/work.test.ts.
 */
import { plural } from './format';
import type { Run, RunArtifact, Step, StepWork } from './schemas';

/** One thing a repository tool did, as it happens. */
export type WorkItem =
  | ({ kind: 'file' } & StepWork['files'][number])
  | ({ kind: 'branch' } & StepWork['branches'][number])
  | ({ kind: 'commit' } & StepWork['commits'][number])
  | ({ kind: 'check' } & StepWork['checks'][number]);

/** Long lists stay readable and a runaway step cannot grow the plan without bound. */
const CAP = { files: 200, branches: 20, commits: 50, checks: 30 };

/**
 * A step's record from its items, in the order they happened. A file keeps "created" if any
 * write created it; a branch is listed once; checks keep the most recent runs.
 */
export function foldWork(items: readonly WorkItem[]): StepWork | undefined {
  if (items.length === 0) return undefined;
  const files = new Map<string, StepWork['files'][number]>();
  const branches = new Map<string, StepWork['branches'][number]>();
  const commits: StepWork['commits'] = [];
  const checks: StepWork['checks'] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const key = `${item.repo}\0${item.path}`;
      const seen = files.get(key);
      files.set(key, {
        repo: item.repo,
        path: item.path,
        change: seen?.change === 'created' ? 'created' : item.change,
      });
    } else if (item.kind === 'branch') {
      const key = `${item.repo}\0${item.name}`;
      const seen = branches.get(key);
      branches.set(key, {
        repo: item.repo,
        name: item.name,
        created: (seen?.created ?? false) || item.created,
      });
    } else if (item.kind === 'commit') {
      const { kind: _kind, ...commit } = item;
      commits.push(commit);
    } else {
      const { kind: _kind, ...check } = item;
      checks.push(check);
    }
  }
  return {
    files: [...files.values()].slice(0, CAP.files),
    branches: [...branches.values()].slice(0, CAP.branches),
    commits: commits.slice(-CAP.commits),
    checks: checks.slice(-CAP.checks),
  };
}

/**
 * A record back as items, so a step resumed after a restart collects on top of what it had done
 * (D33): `foldWork(workItems(w))` is `w`, and items recorded afterwards fold in as usual.
 */
export function workItems(work: StepWork | undefined): WorkItem[] {
  if (!work) return [];
  return [
    ...work.branches.map((b) => ({ kind: 'branch' as const, ...b })),
    ...work.files.map((f) => ({ kind: 'file' as const, ...f })),
    ...work.commits.map((c) => ({ kind: 'commit' as const, ...c })),
    ...work.checks.map((c) => ({ kind: 'check' as const, ...c })),
  ];
}

/** The latest run of each script, in the order the scripts were first run. */
export function latestChecks(work: StepWork): StepWork['checks'] {
  const last = new Map<string, StepWork['checks'][number]>();
  for (const check of work.checks) {
    last.delete(`${check.repo}\0${check.script}`);
    last.set(`${check.repo}\0${check.script}`, check);
  }
  return [...last.values()];
}

export function checkWord(check: StepWork['checks'][number]): string {
  if (check.timedOut) return 'timed out';
  return check.exit === 0 ? 'passed' : 'failed';
}

/** "2 files · 1 commit on magpipe/add-x · test passed": a step's work in one line. */
export function workLine(work: StepWork | undefined): string | null {
  if (!work) return null;
  const parts: string[] = [];
  if (work.files.length > 0) parts.push(plural(work.files.length, 'file'));
  if (work.commits.length > 0) {
    const branch = work.commits[work.commits.length - 1]!.branch;
    parts.push(`${plural(work.commits.length, 'commit')} on ${branch}`);
  } else if (work.branches.length > 0) {
    parts.push(`on ${work.branches[work.branches.length - 1]!.name}`);
  }
  for (const check of latestChecks(work)) parts.push(`${check.script} ${checkWord(check)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The record as plain facts for a later prompt (the next step, the merge): what Magpipe saw the
 * tools do, as opposed to what an agent says it did.
 */
export function workFacts(work: StepWork | undefined): string[] {
  if (!work) return [];
  return [
    ...work.branches.map(
      (b) => `${b.repo}: ${b.created ? 'created and switched to' : 'switched to'} branch ${b.name}`,
    ),
    ...work.files.map((f) => `${f.repo}: ${f.change} ${f.path}`),
    ...work.commits.map((c) => `${c.repo}: committed ${c.sha} on ${c.branch}: ${c.message}`),
    ...latestChecks(work).map(
      (c) =>
        `${c.repo}: ran ${c.script}, ${checkWord(c)}${
          c.timedOut ? '' : ` (exit ${c.exit ?? '?'})`
        } in ${c.seconds.toFixed(1)} s`,
    ),
  ];
}

/**
 * What a step resumed after a restart is told (D33): that it was interrupted, what Magpipe saw
 * its repository tools do before that, and to continue from there rather than start over. Null
 * for a step that was never interrupted.
 */
export function resumeNote(step: Pick<Step, 'restarts' | 'work'>): string | null {
  if (!step.restarts) return null;
  const interrupted = `This step was interrupted by a restart after it had started${
    step.restarts > 1 ? ` (${step.restarts} times)` : ''
  }.`;
  const facts = workFacts(step.work);
  return facts.length
    ? [
        `${interrupted} Before that, Magpipe recorded:`,
        ...facts.map((f) => `- ${f}`),
        'Continue from there: check git_status and the branch, and do not redo work that is already committed.',
      ].join('\n')
    : `${interrupted} Magpipe recorded no repository work before that. Check what is already in place before you redo anything.`;
}

/**
 * The run's artefacts from its steps: each branch committed to, with its commit count and last
 * commit, then each file created or changed. A file is "created" if any step created it.
 */
export function runArtifacts(plan: readonly Pick<Step, 'work'>[]): RunArtifact[] {
  const branches = new Map<string, { repo: string; name: string; commits: StepWork['commits'] }>();
  const files = new Map<string, StepWork['files'][number]>();
  for (const step of plan) {
    for (const c of step.work?.commits ?? []) {
      const key = `${c.repo}\0${c.branch}`;
      const entry = branches.get(key) ?? { repo: c.repo, name: c.branch, commits: [] };
      entry.commits.push(c);
      branches.set(key, entry);
    }
    for (const f of step.work?.files ?? []) {
      const key = `${f.repo}\0${f.path}`;
      const seen = files.get(key);
      files.set(key, { ...f, change: seen?.change === 'created' ? 'created' : f.change });
    }
  }
  const out: RunArtifact[] = [
    ...[...branches.values()].map((b) => {
      const last = b.commits[b.commits.length - 1]!;
      return {
        kind: 'branch' as const,
        repo: b.repo,
        name: b.name,
        detail: `${plural(b.commits.length, 'commit')} · last ${last.sha} ${last.message}`,
      };
    }),
    ...[...files.values()].map((f) => ({
      kind: 'file' as const,
      repo: f.repo,
      name: f.path,
      detail: f.change,
    })),
  ];
  return out.slice(0, 100);
}

/**
 * What the run page lists: the repository work recorded on the steps so far (live while the run
 * goes, and kept when it fails before a merge), then any uploaded or hosted file the output names.
 */
export function shownArtifacts(run: Pick<Run, 'plan' | 'output'>): RunArtifact[] {
  return [
    ...runArtifacts(run.plan),
    ...(run.output?.artifacts.filter((a) => a.blobUrl !== undefined) ?? []),
  ];
}
