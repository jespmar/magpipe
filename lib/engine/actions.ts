/**
 * Action steps (D38): work Magpipe does itself, in the plan like any step, with no model and so
 * no spend. `file_issue` files the spec a run wrote as a Linear issue once every review before it
 * passed, then posts each review as a comment. Its record is the issue row, so a step resumed
 * after a restart finds the issue it filed instead of filing a second one.
 */
import type { Db } from '../db';
import { getLinearSettings, getTracker, linearReady } from '../tracker';
import { acceptanceCriteria, type Criterion } from '../goals';
import {
  getIssue,
  goalIssues,
  issueForRun,
  recordFiledIssue,
  recordState,
  releaseGoalsRun,
  relinkIssue,
  threadIssue,
} from '../tracker/issues';
import { DOCUMENT_CAP, type Goal, type Run, type Step, type StepAction } from '../schemas';
import { EngineError } from './model';

/** `document` is set by an action whose step writes one (read_issue: the spec, D39). */
export type ActionOutcome = { status: 'done' | 'skipped'; summary: string; document?: string };

/**
 * The verdict a judging step's result gives, from its `Verdict:` line: pass (or approve) and
 * fail (or changes requested). Null when it gives none, which counts as not passing.
 */
export function parseVerdict(text: string): 'pass' | 'fail' | null {
  const m =
    /^[\s*#>_-]*verdict[\s*_]*[:\-–—]?[\s*_]*(pass(?:ed|es)?|approved?|fail(?:ed|s)?|changes requested)\b/im.exec(
      text,
    );
  if (!m) return null;
  return /^(pass|approve)/i.test(m[1]!) ? 'pass' : 'fail';
}

/** Every step this one depends on, directly or not. */
function upstreamOf(plan: readonly Step[], step: Step): Step[] {
  const byId = new Map(plan.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      walk(byId.get(id)?.dependsOn ?? []);
    }
  };
  walk(step.dependsOn);
  return plan.filter((s) => seen.has(s.id));
}

/** The spec's own title: its first level-one heading, else the task's first line. */
export function issueTitle(document: string, task: string): string {
  const heading = /^#\s+(.+)$/m.exec(document)?.[1]?.trim();
  const title = heading || task.split('\n')[0]!.trim();
  return title.length > 200 ? `${title.slice(0, 199).trimEnd()}…` : title;
}

export async function runAction(opts: {
  db: Db;
  run: Run;
  step: Step & { action: StepAction };
  agentNames: Map<string, string>;
  signal: AbortSignal;
}): Promise<ActionOutcome> {
  switch (opts.step.action) {
    case 'file_issue':
      return fileIssue(opts);
    case 'read_issue':
      return readIssue(opts);
    case 'file_goals':
      return fileGoals(opts);
  }
}

/** Linear set up, and the spec issue a goals run splits. */
async function goalsContext(db: Db, run: Run) {
  const settings = await getLinearSettings(db);
  if (!linearReady(settings)) {
    throw new EngineError(
      'linear_not_ready',
      'Linear is no longer set up. Finish Settings → Linear, then re-fly this run.',
    );
  }
  const issue = run.input.issueId ? await getIssue(db, run.input.issueId) : undefined;
  if (!issue) throw new EngineError('no_issue', 'This run names no spec issue to split.');
  return { settings, issue, tracker: await getTracker(db, settings) };
}

/**
 * The approved spec as the operator left it (D39): the issue's description in Linear, read when
 * the goals run starts, so an edit made before approving is the spec the goals are split from.
 */
async function readIssue({
  db,
  run,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const { issue, tracker } = await goalsContext(db, run);
  const remote = await tracker.getIssue(issue.externalId, signal);
  const spec = remote.description.trim();
  if (!spec) {
    throw new EngineError(
      'empty_spec',
      `${issue.identifier} has no description to split into goals.`,
    );
  }
  const criteria = acceptanceCriteria(spec);
  return {
    status: 'done',
    summary: `Read ${issue.identifier}, ${remote.title}: ${
      criteria.length
        ? `${criteria.length} acceptance ${criteria.length === 1 ? 'criterion' : 'criteria'}`
        : 'no numbered acceptance criteria'
    }.`,
    document: spec.slice(0, DOCUMENT_CAP),
  };
}

/** Dependencies first, so each goal's blockers exist when it is filed. */
function dependencyOrder(goals: readonly Goal[]): Goal[] {
  const out: Goal[] = [];
  const done = new Set<string>();
  const visit = (g: Goal) => {
    if (done.has(g.key)) return;
    done.add(g.key);
    for (const d of g.dependsOn) {
      const dep = goals.find((x) => x.key === d);
      if (dep) visit(dep);
    }
    out.push(g);
  };
  for (const g of goals) visit(g);
  return out;
}

/** A goal's sub-issue: what to build, the criteria it owns in the spec's words, its files. */
export function goalDescription(
  goal: Goal,
  opts: { spec: { identifier: string; title: string }; criteria: Criterion[]; dependsOn: string[] },
): string {
  const text = new Map(opts.criteria.map((c) => [c.n, c.text]));
  return [
    `Goal \`${goal.key}\` of ${opts.spec.identifier}, ${opts.spec.title}.`,
    '',
    goal.summary,
    '',
    '## Acceptance criteria',
    '',
    ...goal.criteria.map((n) => `${n}. ${text.get(n) ?? '(see the spec)'}`),
    '',
    '## Files',
    '',
    ...goal.files.map((f) => `- \`${f}\``),
    '',
    '## Depends on',
    '',
    ...(opts.dependsOn.length
      ? opts.dependsOn.map((d) => `- ${d}`)
      : ['Nothing: it can start first.']),
  ].join('\n');
}

/**
 * Files the goals that passed review as sub-issues of the spec, in the approved status, each
 * blocked by the goals it depends on; the spec moves to building (D39). Goals that did not pass
 * file nothing: the spec moves to needs you with the findings as a comment. Resumed after a
 * restart, it files only the goals not filed yet.
 */
async function fileGoals({
  db,
  run,
  step,
  agentNames,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const { settings, issue, tracker } = await goalsContext(db, run);
  const upstream = upstreamOf(run.plan, step);
  const judges = upstream.filter((s) => s.judges);
  const comment = async (body: string) => tracker.comment(issue.externalId, body, signal);
  const reviews = judges
    .map(
      (s) =>
        `**${agentNames.get(s.agentId ?? '') ?? 'Magpipe'}**, ${s.title.toLowerCase()}:\n\n${s.result?.summary ?? ''}`,
    )
    .join('\n\n');

  const notPassed = judges.filter((s) => s.verdict !== 'pass');
  if (notPassed.length > 0) {
    const needsYou = settings.states.needs_you!;
    await comment(
      `The goals did not pass review, so none were filed. Answer the findings here or in a follow-up, then move this issue back to ${settings.states.approved!.name} to split it again.\n\n${reviews}`,
    );
    const remote = await tracker.setState(issue.externalId, needsYou.id, signal);
    await recordState(db, issue.id, settings, remote);
    await releaseGoalsRun(db, issue.id);
    return {
      status: 'skipped',
      summary: `Not filed: the goals did not pass review. ${issue.identifier} moved to ${remote.state.name} with the findings.`,
    };
  }

  const source = upstream.find((s) => s.recordsGoals && s.goals);
  if (!source?.goals) throw new EngineError('no_goals', 'There are no goals to file.');
  const spec = upstream.find((s) => s.action === 'read_issue')?.document ?? '';
  const criteria = acceptanceCriteria(spec);

  const filed = new Map(
    (await goalIssues(db, issue.id)).flatMap((g) => (g.goal ? [[g.goal.key, g] as const] : [])),
  );
  const made: string[] = [];
  for (const goal of dependencyOrder(source.goals)) {
    if (filed.has(goal.key)) continue;
    const blockers = goal.dependsOn.map((d) => filed.get(d)!).filter(Boolean);
    const remote = await tracker.createIssue(
      {
        teamId: settings.team!.id,
        title: goal.title,
        description: goalDescription(goal, {
          spec: issue,
          criteria,
          dependsOn: blockers.map((b) => `${b.identifier} (\`${b.goal!.key}\`)`),
        }),
        labelIds: [settings.label!.id],
        stateId: settings.states.approved!.id,
        parentId: issue.externalId,
      },
      signal,
    );
    const row = await recordFiledIssue(db, remote, {
      runId: run.id,
      settings,
      parentId: issue.id,
      goal,
    });
    for (const b of blockers) await tracker.relate(b.externalId, row.externalId, signal);
    filed.set(goal.key, row);
    made.push(row.identifier);
  }

  await comment(
    `Split into ${source.goals.length} ${source.goals.length === 1 ? 'goal' : 'goals'}: ${source.goals
      .map((g) => filed.get(g.key)!.identifier)
      .join(', ')}.\n\n${reviews}`,
  ).catch(() => undefined);
  const building = settings.states.building!;
  const moved = await tracker.setState(issue.externalId, building.id, signal);
  await recordState(db, issue.id, settings, moved);
  const all = source.goals.map((g) => filed.get(g.key)!.identifier);
  return {
    status: 'done',
    summary: `Filed ${all.length} ${all.length === 1 ? 'goal' : 'goals'} under ${issue.identifier}: ${all.join(', ')}${
      made.length < all.length
        ? ` (${all.length - made.length} already filed before a restart)`
        : ''
    }. ${issue.identifier} is now ${moved.state.name}.`,
  };
}

async function fileIssue({
  db,
  run,
  step,
  agentNames,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const already = await issueForRun(db, run.id);
  if (already) {
    // Resumed after a restart: the issue is already filed or updated.
    return {
      status: 'done',
      summary: `${already.identifier} holds the spec, in ${already.stateName}: ${already.url}`,
    };
  }
  const upstream = upstreamOf(run.plan, step);
  const judges = upstream.filter((s) => s.judges);
  const notPassed = judges.filter((s) => s.verdict !== 'pass');
  if (notPassed.length > 0) {
    const why = notPassed
      .map((s) =>
        s.verdict === 'fail'
          ? `“${s.title}” did not pass`
          : `“${s.title}” gave no verdict Magpipe could read`,
      )
      .join('; ');
    return { status: 'skipped', summary: `Not filed: ${why}. Follow up to revise the spec.` };
  }
  const source = upstream.find((s) => s.writesDocument && s.document);
  if (!source) throw new EngineError('no_document', 'There is no spec to file.');

  const settings = await getLinearSettings(db);
  if (!linearReady(settings)) {
    throw new EngineError(
      'linear_not_ready',
      'Linear is no longer set up, so the spec was not filed. Finish Settings → Linear, then re-fly.',
    );
  }
  const tracker = await getTracker(db, settings);
  const title = issueTitle(source.document!, run.input.text);
  // A follow-up revises the spec its conversation filed, while that spec still waits for
  // approval; once it is approved, a revision is a new issue.
  const prior = await threadIssue(db, run);
  let issue;
  let verb: 'Filed' | 'Updated';
  if (prior && prior.stage === 'spec_ready') {
    const remote = await tracker.updateIssue(
      prior.externalId,
      { title, description: source.document! },
      signal,
    );
    issue = await relinkIssue(db, prior.id, { runId: run.id, title: remote.title });
    verb = 'Updated';
  } else {
    const remote = await tracker.createIssue(
      {
        teamId: settings.team!.id,
        title,
        description: source.document!,
        labelIds: [settings.label!.id],
        stateId: settings.states.spec_ready!.id,
      },
      signal,
    );
    issue = await recordFiledIssue(db, remote, { runId: run.id, settings });
    verb = 'Filed';
  }

  // Each verdict is a comment on the issue it concerns, from the agent that owns it.
  const unposted: string[] = [];
  for (const s of judges) {
    const who = agentNames.get(s.agentId ?? '') ?? 'Magpipe';
    try {
      await tracker.comment(
        issue.externalId,
        `**${who}**, ${s.title.toLowerCase()}:\n\n${s.result?.summary ?? ''}`,
        signal,
      );
    } catch (err) {
      unposted.push(`${who} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const earlier =
    verb === 'Filed' && prior
      ? ` ${prior.identifier} already held an earlier version and has moved on from spec ready, so this is a new issue.`
      : '';
  return {
    status: 'done',
    summary: `${verb} ${issue.identifier} in ${issue.stateName}: ${issue.url}${
      unposted.length
        ? `. The review could not be posted as a comment: ${unposted.join('; ')}.`
        : ''
    }${earlier}`,
  };
}
