/**
 * Action steps (D38): work Magpipe does itself, in the plan like any step, with no model and so
 * no spend. `file_issue` files the spec a run wrote as a Linear issue once every review before it
 * passed, then posts each review as a comment. Its record is the issue row, so a step resumed
 * after a restart finds the issue it filed instead of filing a second one.
 */
import type { Db } from '../db';
import { getLinearSettings, getTracker, linearReady } from '../tracker';
import { acceptanceCriteria, type Criterion } from '../goals';
import { workFacts } from '../work';
import { getForge } from '../forge';
import { pushBranch, updateBranch } from '../worktrees';
import {
  getIssue,
  goalIssues,
  issueForRun,
  recordFiledIssue,
  recordState,
  recordMerged,
  recordPull,
  releaseBuildRun,
  releaseGoal,
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
    case 'finish_goal':
      return finishGoal(opts);
    case 'open_pr':
      return openPr(opts);
    case 'update_branch':
      return updateGoalBranch(opts);
    case 'merge_goal':
      return mergeGoal(opts);
  }
}

/** The run's worktree, which a landing action needs (D41, D42). */
function worktreeOf(run: Run) {
  const wt = run.input.worktree;
  if (!wt) throw new EngineError('no_worktree', 'This run has no worktree to push from.');
  return wt;
}

/** Every judge before this step passed, and nothing before it failed. */
function allPassed(upstream: Step[]): boolean {
  const judges = upstream.filter((s) => s.judges);
  return (
    upstream.every((s) => s.status !== 'failed') &&
    judges.length > 0 &&
    judges.every((s) => s.status === 'done' && s.verdict === 'pass')
  );
}

/**
 * Pushes the goal's branch and opens its pull request (D42), once every judge passed. Magpipe
 * pushes, not an agent: only the run's own `magpipe/…` branch, to origin, never forced.
 */
async function openPr({
  db,
  run,
  step,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const { issue } = await goalsContext(db, run);
  if (!allPassed(upstreamOf(run.plan, step))) {
    return { status: 'skipped', summary: 'Not opened: the judges did not all pass.' };
  }
  const wt = worktreeOf(run);
  const { forge, repo } = await getForge(db);
  const { defaultBranch } = await forge.repository(repo, signal);
  await pushBranch(wt.path, wt.branch);
  const pr = await forge.openPullRequest(
    repo,
    {
      head: wt.branch,
      base: defaultBranch,
      title: `${issue.identifier}: ${issue.title}`,
      body: `Built by Magpipe for ${issue.identifier} (${issue.url}). The tests pass, the review approves and the skeptic has no objection.\n\n${upstreamOf(run.plan, step).find((s) => s.action === 'read_issue')?.document ?? ''}`,
    },
    signal,
  );
  await recordPull(db, issue.id, pr);
  return { status: 'done', summary: `Opened pull request #${pr.number}: ${pr.url}` };
}

/**
 * Brings the goal's branch up to date with the base before it merges (D42): the base is merged in
 * (not rebased, so nothing is forced) and the branch pushed. A conflict stops the land.
 */
async function updateGoalBranch({
  db,
  run,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const wt = worktreeOf(run);
  const { forge, repo } = await getForge(db);
  const { defaultBranch } = await forge.repository(repo, signal);
  const update = await updateBranch(wt.path, defaultBranch);
  if (!update.ok) {
    throw new EngineError(
      'conflict',
      `${wt.branch} does not merge cleanly with ${defaultBranch}: ${update.conflicts.join(', ') || 'git could not say which files'}. Resolve it on the branch, or send the goal back.`,
    );
  }
  if (update.changed) await pushBranch(wt.path, wt.branch);
  return {
    status: 'done',
    summary: update.changed
      ? `Merged ${defaultBranch} into ${wt.branch} and pushed it; the tests run again on the result.`
      : `${wt.branch} was already up to date with ${defaultBranch}.`,
  };
}

/**
 * Merges the goal's pull request (D42) when the branch updated cleanly and every judge passed
 * after the update: the goal is done, and the goals that wait for it may start. Anything else
 * moves the goal to needs you with the reason, and it starts over when moved back to approved.
 */
async function mergeGoal({
  db,
  run,
  step,
  agentNames,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const { settings, issue, tracker } = await goalsContext(db, run);
  const upstream = upstreamOf(run.plan, step);
  const who = (s: Step) => (s.agentId ? (agentNames.get(s.agentId) ?? 'Agent') : 'Magpipe');
  const report = upstream
    .filter((s) => s.judges || s.status === 'failed')
    .map(
      (s) =>
        `**${who(s)}**, ${s.title.toLowerCase()}: ${s.status === 'done' ? (s.verdict ?? s.status) : s.status}\n\n${s.result?.summary ?? s.error?.message ?? ''}`,
    )
    .join('\n\n');
  if (!issue.prNumber)
    throw new EngineError('no_pull', `${issue.identifier} has no pull request to merge.`);
  if (!allPassed(upstream)) {
    const failed = upstream.find((s) => s.status === 'failed');
    const why = failed
      ? `“${failed.title}” failed: ${failed.error?.message ?? 'no reason given'}`
      : 'a check before merging did not pass';
    await tracker.comment(
      issue.externalId,
      `Not merged: ${why}. The pull request stays open. Move this issue back to ${settings.states.approved!.name} to build it again.\n\n${report}`,
      signal,
    );
    const moved = await tracker.setState(issue.externalId, settings.states.needs_you!.id, signal);
    await recordState(db, issue.id, settings, moved);
    await releaseGoal(db, issue.id);
    return { status: 'done', summary: `${issue.identifier} needs you: ${why}.` };
  }
  const { forge, repo, settings: forgeSettings } = await getForge(db);
  const merged = await forge.merge(repo, issue.prNumber, forgeSettings.mergeMethod, signal);
  await recordMerged(db, issue.id);
  await tracker.comment(
    issue.externalId,
    `Merged pull request #${issue.prNumber} (${merged.sha}) after bringing it up to date and running the tests again.\n\n${report}`,
    signal,
  );
  const moved = await tracker.setState(issue.externalId, settings.states.done!.id, signal);
  await recordState(db, issue.id, settings, moved);
  return {
    status: 'done',
    summary: `Merged ${issue.identifier}'s pull request #${issue.prNumber}. Moved to ${moved.state.name}.`,
  };
}

/** The branch a goal is built on (D40): `magpipe/<goal key>`. */
export function goalBranch(issue: { goal: Goal | null; identifier: string }): string {
  return `magpipe/${issue.goal?.key ?? issue.identifier.toLowerCase()}`;
}

/**
 * How a goal's build ended (D40), on its issue: every judge passed, so the goal moves to the
 * merge question with its branch named; or something failed or did not pass, so it moves to
 * needs you with the findings and is released to build again when moved back to approved.
 * Runs after everything before it settled, so a failed step is reported too.
 */
async function finishGoal({
  db,
  run,
  step,
  agentNames,
  signal,
}: Parameters<typeof runAction>[0]): Promise<ActionOutcome> {
  const { settings, issue, tracker } = await goalsContext(db, run);
  const upstream = upstreamOf(run.plan, step);
  const failed = upstream.filter((s) => s.status === 'failed');
  const judges = upstream.filter((s) => s.judges);
  const branch = goalBranch(issue);
  const who = (s: Step) => (s.agentId ? (agentNames.get(s.agentId) ?? 'Agent') : 'Magpipe');
  const verdictOf = (s: Step) =>
    s.status === 'done' ? (s.verdict ?? 'no verdict Magpipe could read') : s.status;
  const report = judges
    .map(
      (s) =>
        `**${who(s)}**, ${s.title.toLowerCase()}: ${verdictOf(s)}\n\n${s.result?.summary ?? s.error?.message ?? ''}`,
    )
    .join('\n\n');
  const facts = upstream.flatMap((s) => workFacts(s.work));
  const recorded = facts.length
    ? `\n\nRecorded by Magpipe:\n${facts.map((f) => `- ${f}`).join('\n')}`
    : '';
  const passed =
    failed.length === 0 &&
    judges.length > 0 &&
    judges.every((s) => s.status === 'done' && s.verdict === 'pass');

  const pull = upstream.find((s) => s.action === 'open_pr' && s.status === 'done');
  const current = (await getIssue(db, issue.id)) ?? issue;
  if (passed) {
    // The question to merge (G2, D42): with a pull request, any of three doors answers it.
    const question =
      pull && current.prUrl
        ? `Merge? Pull request #${current.prNumber}: ${current.prUrl}. The tests pass, the review approves and the skeptic has no objection. Answer with Merge or Send back on the goal's flight in Magpipe, by moving this issue to ${settings.states.done!.name}, or by merging the pull request on GitHub.`
        : `Ready to merge: branch \`${branch}\`. The tests pass, the review approves and the skeptic has no objection. Merge the branch, then move this issue to ${settings.states.done!.name}; the goals that wait for it start after.`;
    await tracker.comment(issue.externalId, `${question}\n\n${report}${recorded}`, signal);
    const moved = await tracker.setState(
      issue.externalId,
      settings.states.merge_question!.id,
      signal,
    );
    await recordState(db, issue.id, settings, moved);
    return {
      status: 'done',
      summary: current.prUrl
        ? `${issue.identifier} asks to merge pull request #${current.prNumber}. Moved to ${moved.state.name}.`
        : `${issue.identifier} is ready to merge on ${branch}. Moved to ${moved.state.name}.`,
    };
  }

  const why = failed.length
    ? failed.map((s) => `“${s.title}” failed: ${s.error?.message ?? 'no reason given'}`).join('; ')
    : judges
        .filter((s) => !(s.status === 'done' && s.verdict === 'pass'))
        .map((s) => `“${s.title}” ${s.status === 'done' ? `said ${verdictOf(s)}` : 'did not run'}`)
        .join('; ');
  await tracker.comment(
    issue.externalId,
    `Not ready: ${why}. The work so far is on \`${branch}\`. Answer the findings here, then move this issue back to ${settings.states.approved!.name} to build it again.\n\n${report}${recorded}`,
    signal,
  );
  const moved = await tracker.setState(issue.externalId, settings.states.needs_you!.id, signal);
  await recordState(db, issue.id, settings, moved);
  await releaseBuildRun(db, issue.id);
  return {
    status: 'done',
    summary: `${issue.identifier} needs you: ${why}. Moved to ${moved.state.name} with the findings.`,
  };
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
