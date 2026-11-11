/**
 * Action steps (D38): work Magpipe does itself, in the plan like any step, with no model and so
 * no spend. `file_issue` files the spec a run wrote as a Linear issue once every review before it
 * passed, then posts each review as a comment. Its record is the issue row, so a step resumed
 * after a restart finds the issue it filed instead of filing a second one.
 */
import type { Db } from '../db';
import { getLinearSettings, getTracker, linearReady } from '../tracker';
import { issueForRun, recordFiledIssue, relinkIssue, threadIssue } from '../tracker/issues';
import type { Run, Step, StepAction } from '../schemas';
import { EngineError } from './model';

export type ActionOutcome = { status: 'done' | 'skipped'; summary: string };

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
  }
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
