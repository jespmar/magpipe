/**
 * The tracker seam (D38): what the factory needs from an issue tracker, and nothing more. Linear
 * implements it over its GraphQL API (`linear.ts`); tests and the end-to-end server use the
 * scripted tracker (`scripted.ts`), so no test needs a Linear account.
 */
import type { TrackerRef, TrackerTeam } from '../schemas';

/** A workflow status of a team. `type` is Linear's: backlog, unstarted, started, completed… */
export type TrackerState = TrackerRef & { type: string };

/** An issue as the tracker reports it. */
export type RemoteIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state: TrackerState;
  updatedAt: string;
  /** The parent issue's id, for a sub-issue (a goal, D39). */
  parentId: string | null;
};

export interface Tracker {
  readonly name: 'linear' | 'scripted';
  /** Who the key belongs to: proves the key works. */
  viewer(signal?: AbortSignal): Promise<{ name: string }>;
  teams(signal?: AbortSignal): Promise<TrackerTeam[]>;
  /** The team's statuses, in the team's own order. */
  states(teamId: string, signal?: AbortSignal): Promise<TrackerState[]>;
  /** The label with this name usable in the team (its own or the workspace's), made if missing. */
  ensureLabel(
    teamId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<TrackerRef & { created: boolean }>;
  createIssue(
    input: {
      teamId: string;
      title: string;
      description: string;
      labelIds: string[];
      stateId: string;
      parentId?: string;
    },
    signal?: AbortSignal,
  ): Promise<RemoteIssue>;
  /** One issue with its description: the spec as the operator left it (D39). */
  getIssue(issueId: string, signal?: AbortSignal): Promise<RemoteIssue & { description: string }>;
  setState(issueId: string, stateId: string, signal?: AbortSignal): Promise<RemoteIssue>;
  /** Records that `blockingId` must land before `blockedId` (a goal's dependency, D39). */
  relate(blockingId: string, blockedId: string, signal?: AbortSignal): Promise<void>;
  /** Replaces the title and description: a revised spec on the issue that holds it. */
  updateIssue(
    issueId: string,
    input: { title: string; description: string },
    signal?: AbortSignal,
  ): Promise<RemoteIssue>;
  comment(issueId: string, body: string, signal?: AbortSignal): Promise<void>;
  /** Every issue of the team that carries the label, updated since `since` when given. */
  issuesWithLabel(
    input: { teamId: string; labelId: string; since?: Date },
    signal?: AbortSignal,
  ): Promise<RemoteIssue[]>;
}

/** The tracker refused or could not be reached. `auth` means the key is wrong or revoked. */
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'not_found' | 'network' | 'invalid' | 'unknown' = 'unknown',
  ) {
    super(message);
  }
}
