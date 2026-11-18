/** The pipeline states in the operator's words (Settings, the issue bar). Client-safe. */
import type { IssueStage } from '../schemas';
import type { TrackerState } from './types';

export const PIPELINE_LABELS: Record<IssueStage, string> = {
  spec_ready: 'Spec ready',
  approved: 'Approved',
  building: 'Building',
  merge_question: 'Merge question',
  done: 'Done',
  needs_you: 'Needs you',
  other: 'Not mapped',
};

/** What each pipeline state means, for the mapping's descriptions. */
export const PIPELINE_HINTS: Record<Exclude<IssueStage, 'other'>, string> = {
  spec_ready: 'Where a spec lands once its review passes, waiting for your approval.',
  approved: 'Moving an issue here approves its spec.',
  building: 'Goals being built.',
  merge_question: 'A pull request waiting for your answer to merge.',
  done: 'Merged.',
  needs_you: 'Stopped with findings for you.',
};

/**
 * The choice of a status Magpipe makes in the team (D56): picked for Needs you when the team has
 * no status for it, so a goal that needs a person never lands in Canceled or Done.
 */
export const NEW_NEEDS_YOU = 'new:needs-you';
export const NEEDS_YOU_NAME = 'Needs you';

/** The statuses offered for one pipeline state: the team's, and for Needs you a new one. */
export function statusOptions(
  states: readonly TrackerState[],
  p: Exclude<IssueStage, 'other'>,
): { value: string; label: string }[] {
  const own = states.map((s) => ({ value: s.id, label: s.name }));
  const named = states.some((s) => s.name.trim().toLowerCase() === NEEDS_YOU_NAME.toLowerCase());
  return p === 'needs_you' && !named
    ? [...own, { value: NEW_NEEDS_YOU, label: `${NEEDS_YOU_NAME}, a new status` }]
    : own;
}

/** A mapped status's name, or what a new one will be called. */
export function statusName(states: readonly TrackerState[], id: string): string | undefined {
  if (id === NEW_NEEDS_YOU) return `${NEEDS_YOU_NAME}, a new status`;
  return states.find((s) => s.id === id)?.name;
}

/** Said beside Needs you when it is mapped onto a closed status, where Linear may archive it. */
export function needsYouHint(states: readonly TrackerState[], id: string): string {
  const found = states.find((s) => s.id === id);
  return found && (found.type === 'canceled' || found.type === 'completed')
    ? `${found.name} is a closed status, and Linear may archive issues there. Pick an open one, or ${NEEDS_YOU_NAME}, a new status.`
    : PIPELINE_HINTS.needs_you;
}
