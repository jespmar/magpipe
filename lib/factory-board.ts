/**
 * The factory screen's data (D43): every spec and goal the factory owns, by pipeline stage, with
 * what the operator needs at a glance and nothing a screen must work out: a spec's goal count, a
 * goal's branch, its latest build's verdicts, its pull request and the runs to follow.
 */
import 'server-only';
import { inArray } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { goalBranch } from './engine/actions';
import { forgeReady, getForgeSettings } from './forge';
import {
  issueStages,
  type IssueStage,
  type Run,
  type RunStatus,
  type TrackerIssue,
} from './schemas';
import { getLinearSettings, linearReady } from './tracker';
import { listIssues } from './tracker/issues';
import { listProjects, projectForge, projectLinear } from './projects';

export type BoardRun = { displayId: string; status: RunStatus };
export type BoardVerdict = {
  title: string;
  verdict: 'pass' | 'fail' | 'none' | 'skipped' | 'failed';
};

export type BoardCard = {
  id: string;
  kind: 'spec' | 'goal';
  identifier: string;
  title: string;
  url: string;
  stage: IssueStage;
  stateName: string;
  /** The spec a goal belongs to. */
  parent: string | null;
  /** A spec's goals: how many, and how many are done. */
  goals: { total: number; done: number } | null;
  branch: string | null;
  pr: { number: number; url: string } | null;
  merged: boolean;
  mergeRequested: boolean;
  /** How the merge question was answered: in Magpipe, in Linear, or by the rule (D44). */
  mergeVia: 'magpipe' | 'linear' | 'rule' | null;
  /** The project's name, while the board shows more than one project (D45). */
  project: string | null;
  /** The latest build's judges, in order. */
  verdicts: BoardVerdict[];
  /** The run to follow: the spec run, the goals run, the build or the land, latest first. */
  runs: { label: string; run: BoardRun }[];
};

export type Board = {
  /** Every project with its issue count; the board shows `projectId`'s, or all (D45). */
  projects: { id: string; name: string; count: number }[];
  projectId: string | null;
  linear: boolean;
  github: boolean;
  lastCheckAt: Date | null;
  lastError: string | null;
  columns: { stage: IssueStage; cards: BoardCard[] }[];
  /** Specs and goals the factory owns, and goals in each kind of run right now. */
  counts: { specs: number; goals: number; building: number; landing: number };
};

const ACTIVE: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'waiting']);

function verdictsOf(run: Pick<Run, 'plan'> | undefined): BoardVerdict[] {
  if (!run) return [];
  return run.plan
    .filter((s) => s.judges)
    .map((s) => ({
      title: s.title,
      verdict:
        s.status === 'done'
          ? (s.verdict ?? 'none')
          : s.status === 'failed'
            ? 'failed'
            : s.status === 'skipped'
              ? 'skipped'
              : 'none',
    }));
}

export async function getBoard(db: Db, opts: { projectId?: string } = {}): Promise<Board> {
  const [linear, forge, all, projects] = await Promise.all([
    getLinearSettings(db),
    getForgeSettings(db),
    listIssues(db),
    listProjects(db),
  ]);
  const projectId = projects.some((p) => p.id === opts.projectId) ? opts.projectId! : null;
  const issues = projectId ? all.filter((i) => i.projectId === projectId) : all;
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const shown = projectId ? projects.filter((p) => p.id === projectId) : projects;
  // Ready when the projects shown have Linear (GitHub) set up, each its own or the workspace's.
  const [linearOk, githubOk] = shown.length
    ? await Promise.all([
        Promise.all(shown.map(async (p) => linearReady(await projectLinear(db, p)))),
        Promise.all(shown.map(async (p) => forgeReady(await projectForge(db, p)))),
      ]).then(([l, g]) => [l.some(Boolean), g.some(Boolean)])
    : [linearReady(linear), forgeReady(forge)];
  const runIds = Array.from(
    new Set(
      issues
        .flatMap((i) => [i.runId, i.goalsRunId, i.buildRunId, i.landRunId])
        .filter((x): x is string => Boolean(x)),
    ),
  );
  const runs = runIds.length
    ? await db
        .select({
          id: t.runs.id,
          displayId: t.runs.displayId,
          status: t.runs.status,
          plan: t.runs.plan,
        })
        .from(t.runs)
        .where(inArray(t.runs.id, runIds))
    : [];
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const byId = new Map(issues.map((i) => [i.id, i]));
  const link = (label: string, id: string | null) => {
    const r = id ? byRun.get(id) : undefined;
    return r ? [{ label, run: { displayId: r.displayId, status: r.status } }] : [];
  };

  const card = (i: TrackerIssue): BoardCard => {
    const isGoal = i.goal !== null || i.parentId !== null || i.externalParentId !== null;
    const children = issues.filter((o) => o.parentId === i.id);
    return {
      id: i.id,
      kind: isGoal ? 'goal' : 'spec',
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      stage: i.stage,
      stateName: i.stateName,
      parent: i.parentId ? (byId.get(i.parentId)?.identifier ?? null) : null,
      goals: isGoal
        ? null
        : {
            total: children.length,
            done: children.filter((c) => c.stage === 'done' && (c.prNumber === null || c.mergedAt))
              .length,
          },
      branch: i.goal ? goalBranch(i) : null,
      pr: i.prNumber && i.prUrl ? { number: i.prNumber, url: i.prUrl } : null,
      merged: i.mergedAt !== null,
      mergeRequested: i.mergeRequestedAt !== null,
      mergeVia: i.mergeRequestedVia,
      project:
        projects.length > 1 && !projectId && i.projectId ? (names.get(i.projectId) ?? null) : null,
      verdicts: verdictsOf(i.buildRunId ? byRun.get(i.buildRunId) : undefined),
      runs: isGoal
        ? [...link('Land', i.landRunId), ...link('Build', i.buildRunId)]
        : [...link('Goals', i.goalsRunId), ...link('Spec', i.runId)],
    };
  };

  const cards = issues.map(card);
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      count: all.filter((i) => i.projectId === p.id).length,
    })),
    projectId,
    linear: linearOk!,
    github: githubOk!,
    lastCheckAt: linear.lastCheckAt,
    lastError: linear.lastError,
    columns: issueStages
      .filter((stage) => stage !== 'other' || cards.some((c) => c.stage === 'other'))
      .map((stage) => ({
        stage,
        cards: cards
          .filter((c) => c.stage === stage)
          // Specs first, then goals; the most recently changed first within each.
          .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'spec' ? -1 : 1)),
      })),
    counts: {
      specs: cards.filter((c) => c.kind === 'spec').length,
      goals: cards.filter((c) => c.kind === 'goal').length,
      building: issues.filter(
        (i) => i.buildRunId && ACTIVE.has(byRun.get(i.buildRunId)?.status ?? 'done'),
      ).length,
      landing: issues.filter(
        (i) => i.landRunId && ACTIVE.has(byRun.get(i.landRunId)?.status ?? 'done'),
      ).length,
    },
  };
}
