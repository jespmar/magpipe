/**
 * Pull requests and the merge question (D42): the GitHub client against a fake fetch; Magpipe's
 * guarded push and branch update on a real repository with a bare origin; and the flow against
 * the scripted tracker and forge. A passing build opens a pull request and asks the question;
 * the answer comes from Magpipe (Merge, Send back with a note), from Linear (moved to done) or
 * from GitHub (merged there); a land run brings the branch up to date, re-tests and merges; a
 * conflict or a failed check moves the goal to needs you; dependants wait for the merge.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import type { ModelClient, ModelMessage } from '@/lib/engine/model';
import {
  factoryTick,
  loadFactory,
  readyGoals,
  startBuildRun,
  startLandRun,
  templatePlan,
} from '@/lib/factory';
import { repoFromRemote, saveForgeKey, saveForgeRepo, useForgeFactory } from '@/lib/forge';
import { githubForge } from '@/lib/forge/github';
import { scriptedForge, scriptedForgeStore } from '@/lib/forge/scripted';
import { createRun, getRun } from '@/lib/runs';
import type { Goal, TrackerIssue } from '@/lib/schemas';
import {
  getLinearSettings,
  saveLinearKey,
  saveLinearMapping,
  useTrackerFactory,
} from '@/lib/tracker';
import {
  checkLinear,
  getIssue,
  recordFiledIssue,
  requestMerge,
  sendBackGoal,
} from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';
import { ensureWorktree, pushBranch, updateBranch } from '@/lib/worktrees';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** A repository with a first commit and a bare origin that has it. */
function repoWithOrigin(dir: string) {
  const origin = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'app');
  fs.mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e 0' } }),
  );
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'one\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, origin };
}

/** Someone else lands work on origin's main, through a clone. */
function landOnMain(dir: string, origin: string, file: string, contents: string) {
  const clone = path.join(dir, `clone-${Math.random().toString(36).slice(2)}`);
  git(dir, 'clone', '-q', origin, clone);
  fs.writeFileSync(path.join(clone, file), contents);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', `change ${file}`);
  git(clone, 'push', '-q', 'origin', 'main');
}

// ─── the GitHub client ────────────────────────────────────────────────────

describe('the GitHub client', () => {
  type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
  const fake = (answer: (c: Call) => { status?: number; json: unknown }) => {
    const calls: Call[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      const call = {
        method: init.method ?? 'GET',
        url,
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const { status = 200, json } = answer(call);
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };
  const raw = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state: 'open',
    merged_at: null,
    head: { ref: 'magpipe/a', sha: 'abc' },
    base: { ref: 'main' },
    ...extra,
  });

  it('sends the token as a bearer, reuses an open pull request, and reads the checks', async () => {
    const f = fake((c) =>
      c.url.includes('/check-runs')
        ? { json: { check_runs: [{ status: 'completed', conclusion: 'success' }] } }
        : { json: [raw(7)] },
    );
    const pr = await githubForge('ghp_x', f.impl).openPullRequest('o/r', {
      head: 'magpipe/a',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
      head: 'magpipe/a',
      base: 'main',
      checks: 'success',
    });
    expect(f.calls[0]!.headers.authorization).toBe('Bearer ghp_x');
    expect(f.calls[0]!.url).toBe(
      'https://api.github.com/repos/o/r/pulls?state=open&head=o%3Amagpipe%2Fa',
    );
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('opens one when none is open, and names a refused merge and a refused token', async () => {
    const f = fake((c) =>
      c.method === 'POST'
        ? { json: raw(8) }
        : c.url.includes('/check-runs')
          ? { json: { check_runs: [{ status: 'in_progress', conclusion: null }] } }
          : { json: [] },
    );
    const pr = await githubForge('t', f.impl).openPullRequest('o/r', {
      head: 'magpipe/a',
      base: 'main',
      title: 'MAG-2: a',
      body: 'b',
    });
    expect(pr).toMatchObject({ number: 8, checks: 'pending' });
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({
      head: 'magpipe/a',
      base: 'main',
      title: 'MAG-2: a',
      body: 'b',
    });
    const refused = githubForge(
      't',
      fake(() => ({ status: 405, json: { message: 'Required status check is failing' } })).impl,
    );
    await expect(refused.merge('o/r', 8, 'squash')).rejects.toMatchObject({
      code: 'conflict',
      message: 'GitHub would not merge: Required status check is failing.',
    });
    const bad = githubForge('t', fake(() => ({ status: 401, json: {} })).impl);
    await expect(bad.viewer()).rejects.toMatchObject({ code: 'auth' });
    const merged = githubForge(
      't',
      fake(() => ({ json: raw(9, { merged_at: '2026-11-11T00:00:00Z', state: 'closed' }) })).impl,
    );
    expect(await merged.pullRequest('o/r', 9)).toMatchObject({ state: 'merged', checks: 'none' });
  });

  it('reads owner/name from GitHub remotes', () => {
    expect(repoFromRemote('git@github.com:jespmar/magpipe.git')).toBe('jespmar/magpipe');
    expect(repoFromRemote('https://github.com/jespmar/magpipe')).toBe('jespmar/magpipe');
    expect(repoFromRemote('ssh://git@github.com/o/r.git')).toBe('o/r');
    expect(repoFromRemote('https://gitlab.com/o/r.git')).toBeNull();
  });
});

// ─── pushing and updating, on a real repository ────────────────────────────

describe('push and update', () => {
  let dir: string;
  let repo: string;
  let origin: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-land-git-')));
    ({ repo, origin } = repoWithOrigin(dir));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('pushes only the worktree’s own magpipe/ branch, never forced', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/a', path.join(dir, 'data'));
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'a\n');
    git(wt.path, 'add', 'a.txt');
    git(wt.path, 'commit', '-q', '-m', 'a');
    await pushBranch(wt.path, 'magpipe/a');
    expect(git(origin, 'rev-parse', 'magpipe/a')).toBe(git(wt.path, 'rev-parse', 'HEAD'));
    await expect(pushBranch(wt.path, 'main')).rejects.toThrow('only its own magpipe/ branches');
    await expect(pushBranch(wt.path, 'magpipe/b')).rejects.toThrow('not on magpipe/b');
    // History rewritten locally: the push is refused, not forced.
    git(wt.path, 'commit', '-q', '--amend', '-m', 'a, rewritten');
    await expect(pushBranch(wt.path, 'magpipe/a')).rejects.toThrow('git push refused');
  });

  it('merges the base in, and stops at a conflict leaving the branch as it was', async () => {
    const wt = await ensureWorktree(repo, 'magpipe/c', path.join(dir, 'data'));
    landOnMain(dir, origin, 'other.txt', 'other\n');
    const clean = await updateBranch(wt.path, 'main');
    expect(clean).toEqual({ ok: true, changed: true, base: 'main' });
    expect(fs.existsSync(path.join(wt.path, 'other.txt'))).toBe(true);
    expect(await updateBranch(wt.path, 'main')).toEqual({ ok: true, changed: false, base: 'main' });

    fs.writeFileSync(path.join(wt.path, 'shared.txt'), 'mine\n');
    git(wt.path, 'commit', '-q', '-am', 'mine');
    const before = git(wt.path, 'rev-parse', 'HEAD');
    landOnMain(dir, origin, 'shared.txt', 'theirs\n');
    expect(await updateBranch(wt.path, 'main')).toEqual({
      ok: false,
      conflicts: ['shared.txt'],
      base: 'main',
    });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(wt.path, 'status', '--porcelain')).toBe('');
  });
});

// ─── the merge question ───────────────────────────────────────────────────

function message(content: ModelMessage['content'], stop = 'end_turn'): ModelMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: stop,
    stop_sequence: null,
    content,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as ModelMessage;
}
const text = (s: string) => message([{ type: 'text', text: s, citations: null }]);

/** Every factory judge passes; the Code Agent commits one file through its tools when asked. */
function passingModel(seen: { builds: string[] } = { builds: [] }): ModelClient {
  return {
    async create(p) {
      const system = String(p.system);
      if (system.startsWith('You build one goal')) {
        seen.builds.push(JSON.stringify(p.messages[0]!.content));
        return text('Built it.');
      }
      if (system.includes('"Verdict: pass"')) return text('Verdict: pass');
      return text('Done.');
    },
  };
}

describe('the merge question', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  let repo: string;
  let origin: string;
  const store = scriptedStore(true);
  const forgeStore = scriptedForgeStore(true);
  const previous = { key: process.env.MAGPIPE_SECRET_KEY, data: process.env.MAGPIPE_DATA_DIR };
  let spec: TrackerIssue;

  const goal = (key: string, dependsOn: string[] = []): Goal => ({
    key,
    title: `Goal ${key}`,
    summary: `Build ${key}.`,
    criteria: [1],
    files: [`src/${key}.ts`],
    dependsOn,
  });

  async function fileGoal(key: string, deps: string[] = []): Promise<TrackerIssue> {
    const settings = await getLinearSettings(db);
    const tracker = scriptedTracker('k', store);
    const remote = await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: `Goal ${key}`,
      description: `Goal \`${key}\`.\n\n## Acceptance criteria\n\n1. It works.`,
      labelIds: [store.labels[0]!.id],
      stateId: 'st_todo',
      parentId: spec.externalId,
    });
    const issue = await recordFiledIssue(db, remote, {
      runId: spec.runId!,
      settings,
      parentId: spec.id,
      goal: goal(key, deps),
    });
    await new Promise((r) => setTimeout(r, 5));
    return issue;
  }

  /** Builds a goal to the merge question: its branch gets one commit so the pull request has work. */
  async function buildToQuestion(issue: TrackerIssue, seen?: { builds: string[] }) {
    const engine = new Engine({ client: passingModel(seen), getDb: async () => db });
    const run = (await startBuildRun(db, issue, (id) => engine.enqueue(id)))!;
    const wt = run.input.worktree!.path;
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    // Each build commits something new, a rebuild included.
    fs.writeFileSync(
      path.join(wt, 'src', `${issue.goal!.key}.ts`),
      `export const build = ${Date.now()};\n`,
    );
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', `build ${issue.goal!.key}`);
    await engine.whenIdle();
    return { run: (await getRun(db, run.id))!, wt, engine };
  }

  async function land(issue: TrackerIssue) {
    const engine = new Engine({ client: passingModel(), getDb: async () => db });
    const run = await startLandRun(db, issue, (id) => engine.enqueue(id));
    await engine.whenIdle();
    return run ? (await getRun(db, run.id))! : null;
  }

  const remoteOf = (issue: TrackerIssue) => store.issues.find((i) => i.id === issue.externalId)!;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-land-')));
    process.env.MAGPIPE_DATA_DIR = path.join(dir, '.data');
    ({ repo, origin } = repoWithOrigin(dir));
    useTrackerFactory((key) => scriptedTracker(key, store));
    useForgeFactory((token) => scriptedForge(token, forgeStore));
    ({ db, close } = await openDb('memory://'));
    await loadFactory(db, { path: repo, scripts: ['test'] });
    await saveLinearKey(db, 'lin_api_land');
    await saveLinearMapping(db, {
      teamId: SCRIPTED_TEAM.id,
      label: 'magpipe',
      states: {
        spec_ready: 'st_spec',
        approved: 'st_todo',
        building: 'st_progress',
        merge_question: 'st_review',
        done: 'st_done',
        needs_you: 'st_blocked',
      },
    });
    const settings = await getLinearSettings(db);
    const run = await createRun(db, { text: 'Goals', attachments: [] });
    spec = await recordFiledIssue(
      db,
      await scriptedTracker('k', store).createIssue({
        teamId: SCRIPTED_TEAM.id,
        title: 'Spec',
        description: '# Spec',
        labelIds: [store.labels[0]!.id],
        stateId: 'st_progress',
      }),
      { runId: run.id, settings },
    );
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    useForgeFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ['MAGPIPE_SECRET_KEY', previous.key],
      ['MAGPIPE_DATA_DIR', previous.data],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('without GitHub, the build has no pull request step and finishes as before', async () => {
    const { plan } = await templatePlan(db, 'build', { vars: { branch: 'magpipe/x' } });
    expect(plan.map((s) => s.id)).not.toContain('pr');
    expect(plan.find((s) => s.id === 'finish')!.dependsOn).toEqual(['run', 'review', 'skeptic']);
    await expect(templatePlan(db, 'land', { vars: { branch: 'magpipe/x' } })).resolves.toBeTruthy();
  });

  it('a GitHub token and repository are checked before they are saved', async () => {
    await expect(saveForgeKey(db, 'ghp_bad_1')).rejects.toMatchObject({ code: 'auth' });
    await saveForgeKey(db, 'ghp_good_1234');
    await expect(
      saveForgeRepo(db, { repo: 'nobody/here', mergeMethod: 'squash' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const { settings, defaultBranch } = await saveForgeRepo(db, {
      repo: 'o/app',
      mergeMethod: 'squash',
    });
    expect(settings).toMatchObject({ repo: 'o/app', keyHint: '1234', viewer: 'scripted-operator' });
    expect(defaultBranch).toBe('main');
  });

  it('a passing build pushes, opens the pull request and asks the question', async () => {
    const a = await fileGoal('a');
    const { run } = await buildToQuestion(a);
    expect(run.status).toBe('done');
    expect(run.plan.find((s) => s.id === 'pr')).toMatchObject({
      status: 'done',
      action: 'open_pr',
    });
    expect(git(origin, 'rev-parse', 'magpipe/a')).toBe(git(repo, 'rev-parse', 'magpipe/a'));
    const pr = forgeStore.pulls.find((p) => p.head === 'magpipe/a')!;
    expect(pr).toMatchObject({
      number: 1,
      base: 'main',
      title: `${a.identifier}: Goal a`,
      state: 'open',
    });
    expect(await getIssue(db, a.id)).toMatchObject({
      stage: 'merge_question',
      prNumber: 1,
      prUrl: pr.url,
    });
    expect(remoteOf(a).comments.at(-1)).toMatch(
      /^Merge\? Pull request #1: https:\/\/github\.com\/o\/app\/pull\/1\./,
    );
    expect(run.plan.find((s) => s.id === 'finish')!.result!.summary).toBe(
      `${a.identifier} asks to merge pull request #1. Moved to In Review.`,
    );
  }, 30_000);

  it('Merge in Magpipe lands it: up to date, tested again, checked, merged, done', async () => {
    const [a] = (await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.prNumber, 1))) as TrackerIssue[];
    landOnMain(dir, origin, 'news.txt', 'news\n');
    await requestMerge(db, a!.id);
    const run = (await land(a!))!;
    expect(run.status).toBe('done');
    expect(run.plan.map((s) => [s.id, s.status])).toEqual([
      ['read', 'done'],
      ['update', 'done'],
      ['run', 'done'],
      ['check', 'done'],
      ['land', 'done'],
      ['merge', 'done'],
    ]);
    expect(run.plan.find((s) => s.id === 'update')!.result!.summary).toContain(
      'Merged main into magpipe/a',
    );
    // The run step has no send_back to offer: nothing to return to in a land.
    expect(forgeStore.pulls[0]!.state).toBe('merged');
    expect(await getIssue(db, a!.id)).toMatchObject({
      stage: 'done',
      mergeRequestedVia: 'magpipe',
    });
    expect((await getIssue(db, a!.id))!.mergedAt).toBeInstanceOf(Date);
    expect(remoteOf(a!).comments.at(-1)).toContain('Merged pull request #1');
  }, 30_000);

  it('Send back in Magpipe builds it again with the note for the Code Agent', async () => {
    const b = await fileGoal('b');
    await buildToQuestion(b);
    await sendBackGoal(db, b.id, 'Name the export function exportRuns.');
    const after = (await getIssue(db, b.id))!;
    expect(after).toMatchObject({
      stage: 'approved',
      buildRunId: null,
      operatorNote: 'Name the export function exportRuns.',
    });
    expect(remoteOf(b).state.id).toBe('st_todo');
    const seen = { builds: [] as string[] };
    await buildToQuestion(after, seen);
    expect(seen.builds[0]).toContain(
      'The operator sent this goal back from the merge question: Name the export function exportRuns.',
    );
    expect((await getIssue(db, b.id))!.operatorNote).toBeNull();
  }, 30_000);

  it('moving the goal to done in Linear is a yes: the next check lands it', async () => {
    const [b] = (await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.title, 'Goal b'))) as TrackerIssue[];
    expect(b!.stage).toBe('merge_question');
    scriptedTracker('k', store).move(b!.identifier, 'Done');
    const engine = new Engine({ client: passingModel(), getDb: async () => db });
    await checkLinear(db, {
      force: true,
      afterCheck: (d) => factoryTick(d, (id) => engine.enqueue(id)),
    });
    expect(await getIssue(db, b!.id)).toMatchObject({ mergeRequestedVia: 'linear' });
    await engine.whenIdle();
    expect((await getIssue(db, b!.id))!.mergedAt).toBeInstanceOf(Date);
  }, 30_000);

  it('a pull request merged on GitHub is done at the next check; dependants wait for it', async () => {
    const c = await fileGoal('c');
    const d = await fileGoal('d', ['c']);
    await buildToQuestion(c);
    // Moved to done in Linear but not merged yet: d still waits.
    await db.update(t.trackerIssues).set({ stage: 'done' }).where(eq(t.trackerIssues.id, c.id));
    expect((await readyGoals(db)).map((g) => g.id)).not.toContain(d.id);
    await db
      .update(t.trackerIssues)
      .set({ stage: 'merge_question' })
      .where(eq(t.trackerIssues.id, c.id));
    const pr = (await getIssue(db, c.id))!.prNumber!;
    scriptedForge('k', forgeStore).mergeOnGitHub(pr);
    await checkLinear(db, { force: true, afterCheck: (x) => factoryTick(x, () => undefined) });
    expect(await getIssue(db, c.id)).toMatchObject({ stage: 'done' });
    expect(remoteOf(c).comments.at(-1)).toContain('was merged on GitHub');
    expect((await getIssue(db, d.id))!.buildRunId).not.toBeNull();
  }, 30_000);

  it('a conflict with the base stops the land: the goal needs you, and the PR stays open', async () => {
    const e = await fileGoal('e');
    const { wt } = await buildToQuestion(e);
    fs.writeFileSync(path.join(wt, 'shared.txt'), 'goal e\n');
    git(wt, 'commit', '-q', '-am', 'e edits shared');
    landOnMain(dir, origin, 'shared.txt', 'main edits shared\n');
    await requestMerge(db, e.id);
    const run = (await land((await getIssue(db, e.id))!))!;
    expect(run.status).toBe('failed');
    expect(run.plan.find((s) => s.id === 'update')).toMatchObject({
      status: 'failed',
      error: { code: 'conflict' },
    });
    expect(run.plan.find((s) => s.id === 'land')!.result!.summary).toContain(
      'does not merge cleanly',
    );
    const after = (await getIssue(db, e.id))!;
    expect(after).toMatchObject({
      stage: 'needs_you',
      mergedAt: null,
      landRunId: null,
      buildRunId: null,
    });
    const pr = forgeStore.pulls.find((p) => p.number === after.prNumber)!;
    expect(pr.state).toBe('open');
  }, 30_000);

  it('the merge question is answered only once, and only while it is asked', async () => {
    const [a] = (await db
      .select()
      .from(t.trackerIssues)
      .where(eq(t.trackerIssues.title, 'Goal a'))) as TrackerIssue[];
    await expect(requestMerge(db, a!.id)).rejects.toThrow('not waiting for the question to merge');
    await expect(sendBackGoal(db, a!.id, 'x')).rejects.toThrow(
      'not waiting for the question to merge',
    );
  });
});
