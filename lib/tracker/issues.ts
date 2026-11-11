/**
 * The issues the factory owns (D38): filed by a spec run, or labelled by hand in Linear, and kept
 * as the watcher last saw them. Gate G1 has two doors: moving the issue to the approved status in
 * Linear, which the watcher notices, or Approve in Magpipe, which sets that status in Linear
 * first, so Linear holds the one answer. Each stage change is acted on once: the stored stage is
 * what the next check compares with.
 */
import 'server-only';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { emitEvent } from '../engine/events';
import { newId } from '../ids';
import type { Goal, IssueStage, LinearSettings, TrackerIssue } from '../schemas';
import {
  getLinearSettings,
  getTracker,
  linearReady,
  recordCheck,
  trackerMessage,
  type RemoteIssue,
} from './index';

/** Which pipeline state a status is, by the operator's mapping. */
export function stageOf(settings: Pick<LinearSettings, 'states'>, stateId: string): IssueStage {
  for (const [stage, ref] of Object.entries(settings.states)) {
    if (ref?.id === stateId) return stage as IssueStage;
  }
  return 'other';
}

export async function getIssue(db: Db, id: string): Promise<TrackerIssue | undefined> {
  const [row] = await db.select().from(t.trackerIssues).where(eq(t.trackerIssues.id, id));
  return row;
}

/** The issue a spec run filed, if it filed one. */
export async function issueForRun(db: Db, runId: string): Promise<TrackerIssue | undefined> {
  const [row] = await db
    .select()
    .from(t.trackerIssues)
    .where(eq(t.trackerIssues.runId, runId))
    .orderBy(desc(t.trackerIssues.createdAt))
    .limit(1);
  return row;
}

/**
 * The issue the conversation a run continues already filed: the nearest ancestor's, by
 * `parentRunId`. A follow-up that revises a spec updates that issue instead of filing another.
 */
export async function threadIssue(
  db: Db,
  run: { parentRunId: string | null },
  limit = 10,
): Promise<TrackerIssue | undefined> {
  let parentId = run.parentRunId;
  const seen = new Set<string>();
  for (let i = 0; parentId && i < limit && !seen.has(parentId); i++) {
    seen.add(parentId);
    const issue = await issueForRun(db, parentId);
    if (issue) return issue;
    const [parent] = await db
      .select({ parentRunId: t.runs.parentRunId })
      .from(t.runs)
      .where(eq(t.runs.id, parentId));
    parentId = parent?.parentRunId ?? null;
  }
  return undefined;
}

/** Moves an issue to the run that holds its latest spec, with its new title. */
export async function relinkIssue(
  db: Db,
  id: string,
  patch: { runId: string; title: string },
): Promise<TrackerIssue> {
  const [row] = await db
    .update(t.trackerIssues)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id))
    .returning();
  return row!;
}

export async function listIssues(db: Db): Promise<TrackerIssue[]> {
  return db.select().from(t.trackerIssues).orderBy(desc(t.trackerIssues.updatedAt));
}

/** Keeps an issue a run just filed. */
export async function recordFiledIssue(
  db: Db,
  remote: RemoteIssue,
  opts: { runId: string; settings: LinearSettings; parentId?: string; goal?: Goal },
): Promise<TrackerIssue> {
  const now = new Date();
  const row: TrackerIssue = {
    id: newId('iss'),
    externalId: remote.id,
    identifier: remote.identifier,
    url: remote.url,
    title: remote.title,
    runId: opts.runId,
    stage: stageOf(opts.settings, remote.state.id),
    stateName: remote.state.name,
    parentId: opts.parentId ?? null,
    externalParentId: remote.parentId,
    goal: opts.goal ?? null,
    goalsRunId: null,
    buildRunId: null,
    prNumber: null,
    prUrl: null,
    mergeRequestedAt: null,
    mergeRequestedVia: null,
    landRunId: null,
    mergedAt: null,
    operatorNote: null,
    approvedAt: null,
    approvedVia: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(t.trackerIssues).values(row);
  return row;
}

/** The goals filed under a spec issue, oldest first (D39). */
export async function goalIssues(db: Db, parentId: string): Promise<TrackerIssue[]> {
  return db
    .select()
    .from(t.trackerIssues)
    .where(eq(t.trackerIssues.parentId, parentId))
    .orderBy(asc(t.trackerIssues.createdAt));
}

/** Records the status Magpipe just moved an issue to in Linear. */
export async function recordState(
  db: Db,
  id: string,
  settings: Pick<LinearSettings, 'states'>,
  remote: RemoteIssue,
): Promise<TrackerIssue> {
  const [row] = await db
    .update(t.trackerIssues)
    .set({
      stage: stageOf(settings, remote.state.id),
      stateName: remote.state.name,
      title: remote.title,
      updatedAt: new Date(),
    })
    .where(eq(t.trackerIssues.id, id))
    .returning();
  return row!;
}

/** Marks the goals run a spec issue started, once: false when another start got there first. */
export async function claimGoalsRun(db: Db, id: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(t.trackerIssues)
    .set({ goalsRunId: runId, updatedAt: new Date() })
    .where(and(eq(t.trackerIssues.id, id), isNull(t.trackerIssues.goalsRunId)))
    .returning({ id: t.trackerIssues.id });
  return rows.length > 0;
}

/**
 * Lets a spec start a goals run again: its goals did not pass review and it went to needs you,
 * so moving it back to the approved status splits it afresh.
 */
export async function releaseGoalsRun(db: Db, id: string): Promise<void> {
  await db
    .update(t.trackerIssues)
    .set({ goalsRunId: null, updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id));
}

/** Marks the build run a goal started, once: false when another start got there first (D40). */
export async function claimBuildRun(db: Db, id: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(t.trackerIssues)
    .set({ buildRunId: runId, updatedAt: new Date() })
    .where(and(eq(t.trackerIssues.id, id), isNull(t.trackerIssues.buildRunId)))
    .returning({ id: t.trackerIssues.id });
  return rows.length > 0;
}

/** Lets a goal build again: it went to needs you, and moving it back to approved rebuilds it. */
export async function releaseBuildRun(db: Db, id: string): Promise<void> {
  await db
    .update(t.trackerIssues)
    .set({ buildRunId: null, updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id));
}

/** Records the pull request a goal's build opened (D42). */
export async function recordPull(db: Db, id: string, pr: { number: number; url: string }) {
  await db
    .update(t.trackerIssues)
    .set({ prNumber: pr.number, prUrl: pr.url, updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id));
}

/** Records that a goal's pull request merged (D42); the goals that wait for it may start. */
export async function recordMerged(db: Db, id: string): Promise<void> {
  await db
    .update(t.trackerIssues)
    .set({ mergedAt: new Date(), updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id));
}

/** Marks the land run a goal started, once (D42). */
export async function claimLandRun(db: Db, id: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(t.trackerIssues)
    .set({ landRunId: runId, updatedAt: new Date() })
    .where(and(eq(t.trackerIssues.id, id), isNull(t.trackerIssues.landRunId)))
    .returning({ id: t.trackerIssues.id });
  return rows.length > 0;
}

/**
 * Lets a goal start over from the operator (D42): its build and land runs and the answer to the
 * merge question are cleared, so moving it to the approved status builds it again.
 */
export async function releaseGoal(db: Db, id: string, note?: string | null): Promise<void> {
  await db
    .update(t.trackerIssues)
    .set({
      buildRunId: null,
      landRunId: null,
      mergeRequestedAt: null,
      mergeRequestedVia: null,
      ...(note !== undefined ? { operatorNote: note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(t.trackerIssues.id, id));
}

/** Spec issues that are approved but have not started their goals run (D39). */
export async function approvedWithoutGoals(db: Db): Promise<TrackerIssue[]> {
  return db
    .select()
    .from(t.trackerIssues)
    .where(
      and(
        eq(t.trackerIssues.stage, 'approved'),
        // A spec has no parent at all; a goal's parent may be one Magpipe does not track.
        isNull(t.trackerIssues.parentId),
        isNull(t.trackerIssues.externalParentId),
        isNull(t.trackerIssues.goalsRunId),
      ),
    );
}

async function say(db: Db, issue: TrackerIssue, text: string): Promise<void> {
  if (!issue.runId) return;
  await emitEvent(db, { runId: issue.runId, stepId: null, agentId: null, kind: 'message', text });
}

/** Approve refused: the issue is not waiting for it. */
export class GateError extends Error {
  readonly code = 'conflict';
}

/**
 * Gate G1 from Magpipe: moves the issue to the approved status in Linear, then records it. A
 * failure in Linear changes nothing here.
 */
export async function approveIssue(db: Db, id: string): Promise<TrackerIssue | undefined> {
  const issue = await getIssue(db, id);
  if (!issue) return undefined;
  if (issue.stage !== 'spec_ready') {
    throw new GateError(
      `${issue.identifier} is in ${issue.stateName}, not waiting for approval. Refresh to see where it is.`,
    );
  }
  const settings = await getLinearSettings(db);
  const approved = settings.states.approved;
  if (!approved) throw new GateError('Map the approved status in Settings first.');
  const tracker = await getTracker(db, settings);
  const remote = await tracker.setState(issue.externalId, approved.id);
  const now = new Date();
  const [row] = await db
    .update(t.trackerIssues)
    .set({
      stage: 'approved',
      stateName: remote.state.name,
      title: remote.title,
      approvedAt: now,
      approvedVia: 'magpipe',
      updatedAt: now,
    })
    .where(eq(t.trackerIssues.id, id))
    .returning();
  await say(
    db,
    row!,
    `Approved ${row!.identifier} in Magpipe. Linear shows it as ${remote.state.name}.`,
  );
  return row;
}

/**
 * The merge question answered yes from Magpipe (D42): recorded, and the factory lands the goal.
 * Only a goal at the question with an open pull request can be answered.
 */
export async function requestMerge(db: Db, id: string): Promise<TrackerIssue | undefined> {
  const issue = await getIssue(db, id);
  if (!issue) return undefined;
  if (issue.stage !== 'merge_question' || !issue.prNumber || issue.mergedAt) {
    throw new GateError(
      `${issue.identifier} is in ${issue.stateName}, not waiting for the question to merge. Refresh to see where it is.`,
    );
  }
  if (issue.mergeRequestedAt) return issue;
  const [row] = await db
    .update(t.trackerIssues)
    .set({ mergeRequestedAt: new Date(), mergeRequestedVia: 'magpipe', updatedAt: new Date() })
    .where(eq(t.trackerIssues.id, id))
    .returning();
  await say(db, row!, `Merge requested for ${row!.identifier} in Magpipe.`);
  return row;
}

/**
 * The merge question answered no from Magpipe (D42): the note is posted on the issue and kept
 * for the Code Agent, and the goal moves back to the approved status so the factory builds it
 * again on the same branch. Linear is moved first; a failure there changes nothing here.
 */
export async function sendBackGoal(
  db: Db,
  id: string,
  note: string,
): Promise<TrackerIssue | undefined> {
  const issue = await getIssue(db, id);
  if (!issue) return undefined;
  if (issue.stage !== 'merge_question' || issue.mergeRequestedAt || issue.mergedAt) {
    throw new GateError(
      `${issue.identifier} is in ${issue.stateName}, not waiting for the question to merge. Refresh to see where it is.`,
    );
  }
  const settings = await getLinearSettings(db);
  const tracker = await getTracker(db, settings);
  await tracker.comment(
    issue.externalId,
    `Sent back from the merge question in Magpipe. The goal is built again with this note for the Code Agent:\n\n${note}`,
  );
  const remote = await tracker.setState(issue.externalId, settings.states.approved!.id);
  const row = await recordState(db, id, settings, remote);
  await releaseGoal(db, id, note);
  await say(db, row, `Sent ${row.identifier} back from the merge question: ${note}`);
  return (await getIssue(db, id)) ?? row;
}

export type CheckResult =
  | { status: 'skipped'; reason: 'not_ready' | 'paused' | 'busy' }
  | { status: 'done'; issues: number; changed: number; started: string[] }
  | { status: 'error'; message: string };

/**
 * What the factory does after each check (D39, D40): start the runs the issues now call for and
 * reconcile the ones that ended. Injected, so the tracker does not depend on the engine. It
 * returns what it started (`MAG-1 → flight_7`) and the problems that kept something from
 * starting, which the check records as its error.
 */
export type AfterCheck = (db: Db) => Promise<{ started: string[]; problems: string[] }>;

/** How far back a check reaches past the last one, for clocks that disagree a little. */
const OVERLAP_MS = 2 * 60_000;

const g = globalThis as unknown as {
  __magpipeCheck?: Promise<CheckResult>;
  __magpipeWatcher?: ReturnType<typeof setTimeout>;
};

/**
 * One check: the issues with the label updated since the last check (all of them the first
 * time), each compared with its stored stage. A change is recorded once and said on the run that
 * filed the issue; a move to the approved status opens gate G1. `force` checks even while the
 * watcher is paused (Check now).
 */
export async function checkLinear(
  db: Db,
  opts: { force?: boolean; afterCheck?: AfterCheck } = {},
): Promise<CheckResult> {
  if (g.__magpipeCheck) return { status: 'skipped', reason: 'busy' };
  const run = (async (): Promise<CheckResult> => {
    const settings = await getLinearSettings(db);
    if (!linearReady(settings)) return { status: 'skipped', reason: 'not_ready' };
    if (settings.paused && !opts.force) return { status: 'skipped', reason: 'paused' };
    const at = new Date();
    try {
      const tracker = await getTracker(db, settings);
      const since = settings.lastCheckAt
        ? new Date(settings.lastCheckAt.getTime() - OVERLAP_MS)
        : undefined;
      const remote = await tracker.issuesWithLabel({
        teamId: settings.team!.id,
        labelId: settings.label!.id,
        since,
      });
      let changed = 0;
      for (const r of remote) if (await applyRemote(db, settings, r)) changed++;
      const { started, problems } = opts.afterCheck
        ? await opts.afterCheck(db)
        : { started: [], problems: [] };
      await recordCheck(db, { at, issues: remote.length, changed });
      if (problems.length) await recordCheck(db, { error: problems.join(' ') });
      return { status: 'done', issues: remote.length, changed, started };
    } catch (err) {
      const message = trackerMessage(err);
      await recordCheck(db, { error: message });
      return { status: 'error', message };
    }
  })();
  g.__magpipeCheck = run;
  try {
    return await run;
  } finally {
    g.__magpipeCheck = undefined;
  }
}

/** Stores what Linear says about one issue. True when its stage changed. */
async function applyRemote(db: Db, settings: LinearSettings, r: RemoteIssue): Promise<boolean> {
  const stage = stageOf(settings, r.state.id);
  const now = new Date();
  const [local] = await db
    .select()
    .from(t.trackerIssues)
    .where(eq(t.trackerIssues.externalId, r.id));
  if (!local) {
    // A sub-issue labelled by hand belongs to its parent when Magpipe knows the parent.
    const [parent] = r.parentId
      ? await db
          .select({ id: t.trackerIssues.id })
          .from(t.trackerIssues)
          .where(eq(t.trackerIssues.externalId, r.parentId))
      : [];
    await db.insert(t.trackerIssues).values({
      id: newId('iss'),
      externalId: r.id,
      identifier: r.identifier,
      url: r.url,
      title: r.title,
      runId: null,
      stage,
      stateName: r.state.name,
      parentId: parent?.id ?? null,
      externalParentId: r.parentId,
      goal: null,
      goalsRunId: null,
      buildRunId: null,
      prNumber: null,
      prUrl: null,
      mergeRequestedAt: null,
      mergeRequestedVia: null,
      landRunId: null,
      mergedAt: null,
      operatorNote: null,
      approvedAt: stage === 'approved' ? now : null,
      approvedVia: stage === 'approved' ? 'linear' : null,
      createdAt: now,
      updatedAt: now,
    });
    return false;
  }
  if (local.stage === stage && local.stateName === r.state.name && local.title === r.title) {
    return false;
  }
  const opensGate = stage === 'approved' && !local.approvedAt;
  // The merge question's Linear door (D42): a goal moved from the question to done is a yes,
  // and the factory lands it. Its pull request is not merged yet, so its dependants still wait.
  const answersMerge =
    local.goal !== null &&
    local.stage === 'merge_question' &&
    stage === 'done' &&
    local.prNumber !== null &&
    local.mergedAt === null &&
    local.mergeRequestedAt === null;
  const [row] = await db
    .update(t.trackerIssues)
    .set({
      stage,
      stateName: r.state.name,
      title: r.title,
      identifier: r.identifier,
      url: r.url,
      externalParentId: r.parentId,
      updatedAt: now,
      ...(opensGate ? { approvedAt: now, approvedVia: 'linear' as const } : {}),
      ...(answersMerge ? { mergeRequestedAt: now, mergeRequestedVia: 'linear' as const } : {}),
    })
    .where(eq(t.trackerIssues.id, local.id))
    .returning();
  if (local.stage === stage) return false;
  await say(
    db,
    row!,
    opensGate
      ? `${row!.identifier} was approved in Linear (${r.state.name}).`
      : answersMerge
        ? `${row!.identifier} was moved to ${r.state.name} in Linear: Magpipe merges its pull request.`
        : `${row!.identifier} moved to ${r.state.name} in Linear.`,
  );
  return true;
}

/**
 * The watcher (D38): checks Linear on the interval Settings holds, while the app is open. The
 * first check comes shortly after start and catches up on everything since the last one.
 */
export function scheduleWatcher(
  getDb: () => Promise<Db>,
  afterCheck?: AfterCheck,
  firstDelayMs = 5_000,
): void {
  if (g.__magpipeWatcher) return;
  const tick = async () => {
    let delay = 60_000;
    try {
      const db = await getDb();
      delay = (await getLinearSettings(db)).pollSeconds * 1000;
      const result = await checkLinear(db, { afterCheck });
      if (result.status === 'error') console.warn(`[watcher] ${result.message}`);
    } catch (err) {
      console.warn('[watcher] check failed:', err);
    } finally {
      g.__magpipeWatcher = setTimeout(tick, delay);
      g.__magpipeWatcher.unref?.();
    }
  };
  g.__magpipeWatcher = setTimeout(tick, firstDelayMs);
  g.__magpipeWatcher.unref?.();
}
