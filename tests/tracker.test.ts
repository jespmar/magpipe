/**
 * Linear for the factory (D38): the GraphQL client against a fake fetch; the key, mapping and
 * watcher settings against the scripted tracker; a spec run that files its issue only when the
 * review passed; the watcher noticing a move in Linear once; and gate G1 from Magpipe.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { Engine } from '@/lib/engine';
import { issueTitle, parseVerdict } from '@/lib/engine/actions';
import { listEvents } from '@/lib/engine/events';
import type { ModelClient, ModelMessage } from '@/lib/engine/model';
import { loadFactory, runDocument, templatePlan } from '@/lib/factory';
import { linearOf, listProjects } from '@/lib/projects';
import { createRun, getRun } from '@/lib/runs';
import type { Step } from '@/lib/schemas';
import {
  getLinearSettings,
  getTracker,
  linearReady,
  readBackMapping,
  removeLinearKey,
  saveLinearKey,
  saveWatcher,
  suggestStates,
  TrackerError,
  useTrackerFactory,
} from '@/lib/tracker';
import {
  approveIssue,
  checkLinear,
  GateError,
  issueForRun,
  listIssues,
} from '@/lib/tracker/issues';
import { linearTracker } from '@/lib/tracker/linear';
import {
  SCRIPTED_STATES,
  SCRIPTED_TEAM,
  scriptedStore,
  scriptedTracker,
} from '@/lib/tracker/scripted';
import { setUpProject, TEST_LINEAR_PROJECT } from '@/tests/stubs/project';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

// ─── reading verdicts and titles ──────────────────────────────────────────

describe('verdicts', () => {
  it('reads pass and fail from the verdict line, in the shapes a model writes it', () => {
    expect(parseVerdict('Verdict: pass\n\n- Headings: pass')).toBe('pass');
    expect(parseVerdict('**Verdict:** PASS. Every item holds.')).toBe('pass');
    expect(parseVerdict('## Verdict: fail')).toBe('fail');
    expect(parseVerdict('Some notes first.\nVerdict — changes requested')).toBe('fail');
    expect(parseVerdict('Verdict: approve')).toBe('pass');
    expect(parseVerdict('The spec looks fine to me.')).toBeNull();
    // A checklist line that says pass is not the verdict.
    expect(parseVerdict('- Headings: pass\n- Testable: pass')).toBeNull();
  });

  it('titles the issue from the spec’s heading, else the task', () => {
    expect(issueTitle('# Export runs as CSV\n\n## Problem', 'task')).toBe('Export runs as CSV');
    expect(issueTitle('## Problem only', 'Let me export\nmore')).toBe('Let me export');
    expect(issueTitle(`# ${'a'.repeat(300)}`, 'x')).toHaveLength(200);
  });
});

// ─── the GraphQL client ───────────────────────────────────────────────────

type Call = {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
};

function fakeFetch(answer: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status = 200, json } = answer(call);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('the Linear client', () => {
  it('sends the personal key as the Authorization header and reads the viewer', async () => {
    const f = fakeFetch(() => ({ json: { data: { viewer: { name: 'Ada' } } } }));
    const linear = linearTracker('lin_api_123', f.impl);
    expect(await linear.viewer()).toEqual({ name: 'Ada' });
    expect(f.calls[0]!.url).toBe('https://api.linear.app/graphql');
    expect(f.calls[0]!.headers.authorization).toBe('lin_api_123');
  });

  it('names a refused key, by status or by the error Linear gives', async () => {
    const byStatus = linearTracker('k', fakeFetch(() => ({ status: 401, json: {} })).impl);
    await expect(byStatus.viewer()).rejects.toMatchObject({ code: 'auth' });
    const byError = linearTracker(
      'k',
      fakeFetch(() => ({
        status: 400,
        json: {
          errors: [
            { message: 'Authentication required', extensions: { type: 'authentication error' } },
          ],
        },
      })).impl,
    );
    const err = await byError.viewer().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).message).toContain('did not accept the API key');
    const other = linearTracker(
      'k',
      fakeFetch(() => ({ json: { errors: [{ message: 'Argument Validation Error' }] } })).impl,
    );
    await expect(other.viewer()).rejects.toMatchObject({
      code: 'invalid',
      message: 'Linear answered: Argument Validation Error',
    });
    const down = linearTracker('k', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(down.viewer()).rejects.toMatchObject({ code: 'network' });
  });

  it('orders the statuses as the team does', async () => {
    const f = fakeFetch(() => ({
      json: {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'b', name: 'Done', type: 'completed', position: 3 },
                { id: 'a', name: 'Todo', type: 'unstarted', position: 1 },
              ],
            },
          },
        },
      },
    }));
    expect((await linearTracker('k', f.impl).states('team')).map((s) => s.name)).toEqual([
      'Todo',
      'Done',
    ]);
  });

  it('reuses a workspace or team label by name, and makes one that is missing', async () => {
    const found = fakeFetch(() => ({
      json: {
        data: {
          issueLabels: {
            nodes: [
              { id: 'other', name: 'Magpipe', team: { id: 'elsewhere' } },
              { id: 'ws', name: 'Magpipe', team: null },
            ],
          },
        },
      },
    }));
    expect(await linearTracker('k', found.impl).ensureLabel('team', 'magpipe')).toEqual({
      id: 'ws',
      name: 'Magpipe',
      created: false,
    });
    const made = fakeFetch((call) =>
      call.body.query.includes('issueLabelCreate')
        ? {
            json: {
              data: {
                issueLabelCreate: { success: true, issueLabel: { id: 'new', name: 'magpipe' } },
              },
            },
          }
        : { json: { data: { issueLabels: { nodes: [] } } } },
    );
    expect(await linearTracker('k', made.impl).ensureLabel('team', 'magpipe')).toMatchObject({
      id: 'new',
      created: true,
    });
    expect(made.calls[1]!.body.variables).toEqual({ input: { name: 'magpipe', teamId: 'team' } });
  });

  it('reads labelled issues page by page, filtered by team, label and time', async () => {
    const issue = (n: number) => ({
      id: `i${n}`,
      identifier: `ENG-${n}`,
      url: `u${n}`,
      title: 't',
      updatedAt: '2026-11-11T00:00:00Z',
      state: { id: 's', name: 'Todo', type: 'unstarted' },
    });
    const f = fakeFetch((call) => ({
      json: {
        data: {
          issues: call.body.variables.after
            ? { nodes: [issue(2)], pageInfo: { hasNextPage: false, endCursor: null } }
            : { nodes: [issue(1)], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
        },
      },
    }));
    const since = new Date('2026-11-10T00:00:00Z');
    const out = await linearTracker('k', f.impl).issuesWithLabel({
      teamId: 'team',
      labelId: 'lbl',
      since,
    });
    expect(out.map((i) => i.identifier)).toEqual(['ENG-1', 'ENG-2']);
    expect(f.calls[0]!.body.variables).toEqual({
      after: null,
      filter: {
        team: { id: { eq: 'team' } },
        labels: { some: { id: { eq: 'lbl' } } },
        updatedAt: { gte: since.toISOString() },
      },
    });
    expect(f.calls[1]!.body.variables.after).toBe('c1');
  });
});

describe('suggestStates', () => {
  const linearDefaults = [
    { id: 'backlog', name: 'Backlog', type: 'backlog' },
    { id: 'todo', name: 'Todo', type: 'unstarted' },
    { id: 'progress', name: 'In Progress', type: 'started' },
    { id: 'review', name: 'In Review', type: 'started' },
    { id: 'done', name: 'Done', type: 'completed' },
    { id: 'canceled', name: 'Canceled', type: 'canceled' },
  ];
  it('guesses Linear’s default workflow, one status each', () => {
    const s = suggestStates(linearDefaults);
    expect(s).toEqual({
      spec_ready: 'backlog',
      approved: 'todo',
      building: 'progress',
      merge_question: 'review',
      done: 'done',
      needs_you: 'canceled',
    });
    expect(new Set(Object.values(s)).size).toBe(6);
  });
  it('finds the scripted team’s own names', () => {
    expect(suggestStates(SCRIPTED_STATES)).toEqual({
      spec_ready: 'st_spec',
      approved: 'st_todo',
      building: 'st_progress',
      merge_question: 'st_review',
      done: 'st_done',
      needs_you: 'st_blocked',
    });
  });
});

// ─── the settings, a spec run, the watcher and the gate ────────────────────

const MAPPING = {
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
};

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

const SPEC = '# Export runs as CSV\n\n## Problem\n\nCopying by hand.\n\n## Outcome\n\nA CSV.';

/** A model whose Spec Builder writes SPEC and whose Spec Review gives `verdict`. */
function specModel(verdict: string): ModelClient {
  return {
    async create(p) {
      return String(p.system).startsWith('You write the spec')
        ? text(SPEC)
        : text(`${verdict}\n\n- Headings: pass`);
    },
  };
}

describe('Linear for the factory', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  let store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    store = scriptedStore(true);
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-tracker-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e 0' } }),
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await loadFactory(db, { path: dir, scripts: ['test'] });
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('refuses a key Linear does not accept, and stores nothing', async () => {
    await expect(saveLinearKey(db, 'lin_api_bad_1')).rejects.toMatchObject({ code: 'auth' });
    expect(await db.select().from(t.secrets)).toHaveLength(0);
    expect((await getLinearSettings(db)).keyRef).toBeNull();
  });

  it('stores a good key sealed, shows only its end, and replaces it cleanly', async () => {
    const first = await saveLinearKey(db, '  lin_api_first_abcd ');
    expect(first.teams).toEqual([SCRIPTED_TEAM]);
    expect(first.settings).toMatchObject({ keyHint: 'abcd', viewer: 'Scripted Operator' });
    const [sealed] = await db.select().from(t.secrets);
    expect(sealed!.ciphertext).not.toContain('lin_api');
    await saveLinearKey(db, 'lin_api_second_wxyz');
    const secrets = await db.select().from(t.secrets);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.id).not.toBe(sealed!.id);
    expect((await getLinearSettings(db)).keyHint).toBe('wxyz');
  });

  it('leaves the issue step out of the spec template until Linear is set up', async () => {
    const { plan } = await templatePlan(db, 'spec');
    expect(plan.map((s) => s.id)).toEqual(['spec', 'review', 'merge']);
    expect(plan[1]).toMatchObject({ judges: true });
  });

  it('refuses two states on one status, then saves the mapping read back from Linear', async () => {
    const tracker = await getTracker(db);
    await expect(
      readBackMapping(tracker, { ...MAPPING, states: { ...MAPPING.states, approved: 'st_spec' } }),
    ).rejects.toThrow('Spec ready and Approved both use Spec ready.');
    const read = await readBackMapping(tracker, MAPPING);
    expect(read).toMatchObject({
      label: { name: 'magpipe', created: true },
      statuses: SCRIPTED_STATES.length,
    });
    expect(read.states.approved).toEqual({ id: 'st_todo', name: 'Approved' });
    // The key alone does not make the project ready: it needs its own Linear project (D46).
    expect(linearReady((await linearOf(db)).settings)).toBe(false);
    await setUpProject(db, { label: MAPPING.label, states: MAPPING.states });
    const { settings } = await linearOf(db);
    expect(settings.states.approved).toEqual({ id: 'st_todo', name: 'Approved' });
    expect(linearReady(settings)).toBe(true);
    expect((await readBackMapping(tracker, MAPPING)).label.created).toBe(false);
  });

  it('a spec whose review fails is not filed', async () => {
    const engine = new Engine({ client: specModel('Verdict: fail'), getDb: async () => db });
    const preset = await templatePlan(db, 'spec');
    expect(preset.plan.map((s) => s.id)).toEqual(['spec', 'review', 'issue', 'merge']);
    const run = await createRun(
      db,
      { text: 'CSV export', attachments: [], template: 'spec' },
      null,
      preset,
    );
    engine.enqueue(run.id);
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    const issueStep = done.plan.find((s) => s.id === 'issue')!;
    expect(done.plan.find((s) => s.id === 'review')!.verdict).toBe('fail');
    expect(issueStep).toMatchObject({ status: 'skipped' });
    expect(issueStep.result!.summary).toContain('“Review the spec” did not pass');
    expect(store.issues).toHaveLength(0);
    expect(done.output!.markdown).toContain('## File the issue\n\nMagpipe: Not filed');
  }, 20_000);

  let runId = '';

  it('a spec that passes is filed in Spec ready with the label, and the review as a comment', async () => {
    const engine = new Engine({ client: specModel('**Verdict:** pass'), getDb: async () => db });
    const preset = await templatePlan(db, 'spec');
    const run = await createRun(
      db,
      { text: 'CSV export', attachments: [], template: 'spec' },
      null,
      preset,
    );
    runId = run.id;
    engine.enqueue(run.id);
    await engine.whenIdle();
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe('done');
    expect(store.issues).toHaveLength(1);
    const remote = store.issues[0]!;
    expect(remote).toMatchObject({
      title: 'Export runs as CSV',
      description: SPEC,
      labelIds: [store.labels[0]!.id],
      state: { id: 'st_spec' },
    });
    expect(remote.comments).toEqual([
      '**Spec Review**, review the spec:\n\n**Verdict:** pass\n\n- Headings: pass',
    ]);
    const issue = (await issueForRun(db, run.id))!;
    expect(issue).toMatchObject({
      identifier: 'MAG-1',
      stage: 'spec_ready',
      stateName: 'Spec ready',
    });
    const step = done.plan.find((s) => s.id === 'issue') as Step;
    expect(step).toMatchObject({ status: 'done', agentId: null, action: 'file_issue' });
    expect(done.output!.markdown).toContain(
      `## File the issue\n\nMagpipe: Filed MAG-1 in Spec ready: ${remote.url}`,
    );
    // No model call for the action: one for the spec, one for the review.
    expect(done.usage.inputTokens).toBe(200);
  }, 20_000);

  it('a refused key fails the issue step, not the run, and the answer says so', async () => {
    useTrackerFactory((key) => scriptedTracker(`lin_api_bad_${key}`, store));
    try {
      const engine = new Engine({ client: specModel('Verdict: pass'), getDb: async () => db });
      const run = await createRun(
        db,
        { text: 'CSV export again', attachments: [], template: 'spec' },
        null,
        await templatePlan(db, 'spec'),
      );
      engine.enqueue(run.id);
      await engine.whenIdle();
      const done = (await getRun(db, run.id))!;
      expect(done.status).toBe('done');
      expect(done.plan.find((s) => s.id === 'issue')).toMatchObject({
        status: 'failed',
        error: { code: 'tracker_auth' },
      });
      expect(done.output!.markdown).toContain(
        'Magpipe: Not filed. Linear did not accept the API key.',
      );
    } finally {
      useTrackerFactory((key) => scriptedTracker(key, store));
    }
  }, 20_000);

  it('the watcher notices a move to the approved status once, and says it on the run', async () => {
    const first = await checkLinear(db);
    expect(first).toMatchObject({ status: 'done', issues: 1, changed: 0 });

    scriptedTracker('k', store).move('MAG-1', 'Approved');
    expect(await checkLinear(db)).toMatchObject({ status: 'done', issues: 1, changed: 1 });
    const issue = (await issueForRun(db, runId))!;
    expect(issue).toMatchObject({ stage: 'approved', approvedVia: 'linear' });
    expect(issue.approvedAt).toBeInstanceOf(Date);
    const events = await listEvents(db, runId);
    expect(events.at(-1)!.text).toBe('MAG-1 was approved in Linear (Approved).');

    // Acted on once: the next check sees the same stage and says nothing.
    expect(await checkLinear(db)).toMatchObject({ changed: 0 });
    expect((await listEvents(db, runId)).length).toBe(events.length);
    const settings = await getLinearSettings(db);
    expect(settings.lastCheck).toEqual({ issues: 1, changed: 0 });
    expect(settings.lastError).toBeNull();
  });

  it('keeps an issue labelled by hand, and pauses unless asked to check now', async () => {
    const tracker = scriptedTracker('k', store);
    await tracker.createIssue({
      teamId: SCRIPTED_TEAM.id,
      title: 'Written by hand',
      description: '',
      labelIds: [store.labels[0]!.id],
      stateId: 'st_backlog',
      projectId: TEST_LINEAR_PROJECT.id,
    });
    await saveWatcher(db, { pollSeconds: 30, paused: true });
    expect(await checkLinear(db)).toEqual({ status: 'skipped', reason: 'paused' });
    expect(await checkLinear(db, { force: true })).toMatchObject({ status: 'done' });
    const hand = (await listIssues(db)).find((i) => i.title === 'Written by hand')!;
    expect(hand).toMatchObject({ runId: null, stage: 'other', stateName: 'Backlog' });
    await saveWatcher(db, { pollSeconds: 60, paused: false });
  });

  it('gate G1 from Magpipe sets Linear first, and only for a spec that is waiting', async () => {
    const engine = new Engine({ client: specModel('Verdict: pass'), getDb: async () => db });
    const run = await createRun(
      db,
      { text: 'Another spec', attachments: [], template: 'spec' },
      null,
      await templatePlan(db, 'spec'),
    );
    engine.enqueue(run.id);
    await engine.whenIdle();
    const issue = (await issueForRun(db, run.id))!;
    expect(issue.stage).toBe('spec_ready');

    const approved = (await approveIssue(db, issue.id))!;
    expect(approved).toMatchObject({
      stage: 'approved',
      approvedVia: 'magpipe',
      stateName: 'Approved',
    });
    expect(store.issues.find((i) => i.id === issue.externalId)!.state.id).toBe('st_todo');
    expect((await listEvents(db, run.id)).at(-1)!.text).toBe(
      `Approved ${issue.identifier} in Magpipe. Linear shows it as Approved.`,
    );
    await expect(approveIssue(db, issue.id)).rejects.toBeInstanceOf(GateError);
    // The watcher then sees what Magpipe already recorded, and does not announce it again.
    expect(await checkLinear(db, { force: true })).toMatchObject({ changed: 0 });
  }, 20_000);

  it('a follow-up revises the issue still waiting, and files anew once it was approved', async () => {
    const engine = new Engine({ client: specModel('Verdict: pass'), getDb: async () => db });
    const send = async (text: string, parent: string | null) => {
      const parentRun = parent ? await getRun(db, parent) : undefined;
      const run = await createRun(
        db,
        { text, attachments: [], template: 'spec' },
        parent,
        await templatePlan(db, 'spec', {
          draft: parentRun ? runDocument(parentRun.plan) : undefined,
        }),
      );
      engine.enqueue(run.id);
      await engine.whenIdle();
      return (await getRun(db, run.id))!;
    };
    const first = await send('Spec to revise', null);
    const issue = (await issueForRun(db, first.id))!;
    const filed = store.issues.length;

    const second = await send('Also cover the filters', first.id);
    expect(store.issues).toHaveLength(filed);
    const remote = store.issues.find((i) => i.id === issue.externalId)!;
    expect(remote.comments).toHaveLength(2);
    expect((await issueForRun(db, second.id))!.id).toBe(issue.id);
    expect(await issueForRun(db, first.id)).toBeUndefined();
    expect(second.plan.find((s) => s.id === 'issue')!.result!.summary).toBe(
      `Updated ${issue.identifier} in Spec ready: ${issue.url}`,
    );

    await approveIssue(db, issue.id);
    const third = await send('And the dates', second.id);
    expect(store.issues).toHaveLength(filed + 1);
    const summary = third.plan.find((s) => s.id === 'issue')!.result!.summary;
    expect(summary).toMatch(/^Filed MAG-\d+ in Spec ready/);
    expect(summary).toContain(`${issue.identifier} already held an earlier version`);
  }, 30_000);

  it('a check with a refused key records the error and keeps the last good check time', async () => {
    const before = (await getLinearSettings(db)).lastCheckAt;
    expect(before).toBeInstanceOf(Date);
    useTrackerFactory((key) => scriptedTracker(`lin_api_bad_${key}`, store));
    try {
      const result = await checkLinear(db);
      expect(result).toMatchObject({ status: 'error' });
      const after = await getLinearSettings(db);
      expect(after.lastError).toContain('did not accept the API key');
      // The next good check reaches back over the outage.
      expect(after.lastCheckAt).toEqual(before);
    } finally {
      useTrackerFactory((key) => scriptedTracker(key, store));
    }
  });

  it('saving the mapping again makes the next check read every labelled issue', async () => {
    await setUpProject(db, { label: MAPPING.label, states: MAPPING.states });
    expect((await getLinearSettings(db)).lastCheckAt).toBeNull();
    const all = await checkLinear(db);
    expect(all).toMatchObject({ status: 'done', issues: store.issues.length });
  });

  it('removing the key keeps the mapping and drops the issue step again', async () => {
    const after = await removeLinearKey(db);
    expect(after).toMatchObject({ keyRef: null, keyHint: null });
    // The mapping is the project's (D46): it keeps its team, without a key to use it.
    const { project, settings } = await linearOf(db);
    expect(project!.linear).toMatchObject({ team: SCRIPTED_TEAM, project: TEST_LINEAR_PROJECT });
    expect(settings).toMatchObject({ keyRef: null, team: SCRIPTED_TEAM });
    expect(linearReady(settings)).toBe(false);
    expect(await db.select().from(t.secrets)).toHaveLength(0);
    expect((await templatePlan(db, 'spec')).plan.map((s) => s.id)).toEqual([
      'spec',
      'review',
      'merge',
    ]);
    const [row] = await listProjects(db);
    expect(row!.linear.states.done).toEqual({ id: 'st_done', name: 'Done' });
  });
});
