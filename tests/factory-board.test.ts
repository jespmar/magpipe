/**
 * The factory board (D43): every issue the factory owns in its stage's column, a spec with its
 * goal count, a goal with its branch, pull request, latest build's verdicts and the runs to follow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getBoard } from '@/lib/factory-board';
import { createRun } from '@/lib/runs';
import type { Goal, Step } from '@/lib/schemas';
import {
  saveLinearKey,
  saveLinearMapping,
  useTrackerFactory,
  getLinearSettings,
} from '@/lib/tracker';
import { recordFiledIssue, recordMerged, recordPull } from '@/lib/tracker/issues';
import { SCRIPTED_TEAM, scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

const goal = (key: string): Goal => ({
  key,
  title: `Goal ${key}`,
  summary: 'x',
  criteria: [1],
  files: [`src/${key}.ts`],
  dependsOn: [],
});

const judge = (id: string, title: string, extra: Partial<Step>): Step => ({
  id,
  agentId: null,
  title,
  dependsOn: [],
  status: 'done',
  judges: true,
  ...extra,
});

describe('the factory board', () => {
  let db: Db;
  let close: () => Promise<void>;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key) => scriptedTracker(key, store));
    ({ db, close } = await openDb('memory://'));
  }, 30_000);
  afterAll(async () => {
    useTrackerFactory(undefined);
    await close();
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('says Linear is not set up and shows nothing before it is', async () => {
    const board = await getBoard(db);
    expect(board).toMatchObject({ linear: false, github: false, counts: { specs: 0, goals: 0 } });
    expect(board.columns.map((c) => c.stage)).toEqual([
      'spec_ready',
      'approved',
      'building',
      'merge_question',
      'done',
      'needs_you',
    ]);
  });

  it('lays out specs and goals by stage with what a glance needs', async () => {
    await saveLinearKey(db, 'lin_api_board');
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
    const tracker = scriptedTracker('k', store);
    const specRun = await createRun(db, { text: 'spec', attachments: [] });
    const mk = async (title: string, stateId: string, parentId?: string) =>
      tracker.createIssue({
        teamId: SCRIPTED_TEAM.id,
        title,
        description: '',
        labelIds: ['lbl'],
        stateId,
        parentId,
      });
    const specRemote = await mk('Export runs', 'st_progress');
    const spec = await recordFiledIssue(db, specRemote, { runId: specRun.id, settings });
    const waiting = await recordFiledIssue(db, await mk('Another idea', 'st_spec'), {
      runId: specRun.id,
      settings,
    });
    const a = await recordFiledIssue(db, await mk('Goal a', 'st_review', specRemote.id), {
      runId: specRun.id,
      settings,
      parentId: spec.id,
      goal: goal('a'),
    });
    const b = await recordFiledIssue(db, await mk('Goal b', 'st_done', specRemote.id), {
      runId: specRun.id,
      settings,
      parentId: spec.id,
      goal: goal('b'),
    });
    const build = await createRun(db, { text: 'Build a', attachments: [] }, null, {
      text: 'build',
      plan: [
        judge('run', 'Run the tests', { verdict: 'pass' }),
        judge('review', 'Review the code', { verdict: 'pass' }),
        judge('skeptic', 'Try to break it', { status: 'failed' }),
      ],
    });
    await db
      .update(t.trackerIssues)
      .set({ buildRunId: build.id })
      .where(eq(t.trackerIssues.id, a.id));
    await recordPull(db, a.id, { number: 4, url: 'https://github.com/o/r/pull/4' });
    await recordPull(db, b.id, { number: 3, url: 'https://github.com/o/r/pull/3' });
    await recordMerged(db, b.id);

    const board = await getBoard(db);
    expect(board.counts).toMatchObject({ specs: 2, goals: 2, building: 1, landing: 0 });
    const column = (stage: string) => board.columns.find((c) => c.stage === stage)!.cards;
    expect(column('spec_ready').map((c) => c.identifier)).toEqual([waiting.identifier]);
    expect(column('building')[0]).toMatchObject({
      kind: 'spec',
      identifier: spec.identifier,
      goals: { total: 2, done: 1 },
      runs: [{ label: 'Spec', run: { displayId: specRun.displayId } }],
    });
    expect(column('merge_question')[0]).toMatchObject({
      kind: 'goal',
      parent: spec.identifier,
      branch: 'magpipe/a',
      pr: { number: 4 },
      merged: false,
      verdicts: [
        { title: 'Run the tests', verdict: 'pass' },
        { title: 'Review the code', verdict: 'pass' },
        { title: 'Try to break it', verdict: 'failed' },
      ],
      runs: [{ label: 'Build', run: { displayId: build.displayId, status: 'queued' } }],
    });
    expect(column('done')[0]).toMatchObject({ identifier: b.identifier, merged: true });
  });
});
