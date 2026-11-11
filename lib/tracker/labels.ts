/** The pipeline states in the operator's words (Settings, the issue bar). Client-safe. */
import type { IssueStage } from '../schemas';

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
