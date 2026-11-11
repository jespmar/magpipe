/**
 * A scripted tracker for tests and the end-to-end server (`MAGPIPE_TRACKER_STUB=scripted`, never
 * in production): one team, MAG, with a Linear-like workflow, kept in memory. Any key works
 * except one that starts with `lin_api_bad`, which is refused the way Linear refuses a revoked
 * key. `move` changes an issue's status as a person in Linear would.
 */
import type { TrackerRef } from '../schemas';
import { TrackerError, type RemoteIssue, type Tracker, type TrackerState } from './types';

export const SCRIPTED_TEAM = { id: 'team_mag', key: 'MAG', name: 'Magpipe' };

/** The team's Linear projects (D45). */
export const SCRIPTED_PROJECTS: TrackerRef[] = [
  { id: 'lp_web', name: 'Web app' },
  { id: 'lp_api', name: 'API' },
];

export const SCRIPTED_STATES: TrackerState[] = [
  { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st_spec', name: 'Spec ready', type: 'unstarted' },
  { id: 'st_todo', name: 'Approved', type: 'unstarted' },
  { id: 'st_progress', name: 'In Progress', type: 'started' },
  { id: 'st_review', name: 'In Review', type: 'started' },
  { id: 'st_blocked', name: 'Blocked', type: 'started' },
  { id: 'st_done', name: 'Done', type: 'completed' },
];

type Store = {
  labels: (TrackerRef & { teamId: string })[];
  issues: (Omit<RemoteIssue, 'labels'> & {
    labelIds: string[];
    projectId: string | null;
    description: string;
    comments: string[];
  })[];
  /** `blocking blocks blocked`, by issue id. */
  relations: { blocking: string; blocked: string }[];
  next: number;
};

const g = globalThis as unknown as { __magpipeScriptedTracker?: Store };

/** The shared store; tests pass their own so they never see each other's issues. */
export function scriptedStore(fresh = false): Store {
  if (fresh || !g.__magpipeScriptedTracker) {
    g.__magpipeScriptedTracker = { labels: [], issues: [], relations: [], next: 1 };
  }
  return g.__magpipeScriptedTracker;
}

export function scriptedTracker(
  apiKey: string,
  store: Store = scriptedStore(),
): Tracker & { store: Store; move(identifier: string, stateName: string): RemoteIssue } {
  const authed = () => {
    if (apiKey.startsWith('lin_api_bad')) {
      throw new TrackerError(
        'Linear did not accept the API key. Check that it is a personal API key and not revoked.',
        'auth',
      );
    }
  };
  const team = (id: string) => {
    if (id !== SCRIPTED_TEAM.id) throw new TrackerError('Linear has no such team.', 'not_found');
  };
  const state = (id: string) => {
    const found = SCRIPTED_STATES.find((s) => s.id === id);
    if (!found) throw new TrackerError(`Linear answered: no status ${id}.`, 'invalid');
    return found;
  };
  const issue = (id: string) => {
    const found = store.issues.find((i) => i.id === id);
    if (!found) throw new TrackerError('Linear has no such issue.', 'not_found');
    return found;
  };
  const touch = (i: Store['issues'][number]) => {
    i.updatedAt = new Date().toISOString();
  };
  const view = ({
    labelIds,
    projectId: _p,
    description: _d,
    comments: _c,
    ...rest
  }: Store['issues'][number]) =>
    ({
      ...rest,
      state: { ...rest.state },
      labels: labelIds.map((id) => store.labels.find((l) => l.id === id)?.name ?? id),
    }) as RemoteIssue;

  return {
    name: 'scripted',
    store,
    async viewer() {
      authed();
      return { name: 'Scripted Operator' };
    },
    async teams() {
      authed();
      return [SCRIPTED_TEAM];
    },
    async projects(teamId) {
      authed();
      team(teamId);
      return SCRIPTED_PROJECTS.map((p) => ({ ...p }));
    },
    async states(teamId) {
      authed();
      team(teamId);
      return SCRIPTED_STATES.map((s) => ({ ...s }));
    },
    async ensureLabel(teamId, name) {
      authed();
      team(teamId);
      const found = store.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (found) return { id: found.id, name: found.name, created: false };
      const label = { id: `lbl_${store.labels.length + 1}`, name, teamId };
      store.labels.push(label);
      return { id: label.id, name, created: true };
    },
    async createIssue(input) {
      authed();
      team(input.teamId);
      const n = store.next++;
      const made = {
        id: `iss_remote_${n}`,
        identifier: `${SCRIPTED_TEAM.key}-${n}`,
        url: `https://linear.app/scripted/issue/${SCRIPTED_TEAM.key}-${n}`,
        title: input.title,
        state: state(input.stateId),
        updatedAt: new Date().toISOString(),
        labelIds: input.labelIds,
        projectId: input.projectId ?? null,
        description: input.description,
        comments: [],
        parentId: input.parentId ?? null,
      };
      store.issues.push(made);
      return view(made);
    },
    async setState(issueId, stateId) {
      authed();
      const found = issue(issueId);
      found.state = state(stateId);
      touch(found);
      return view(found);
    },
    async updateIssue(issueId, input) {
      authed();
      const found = issue(issueId);
      found.title = input.title;
      found.description = input.description;
      touch(found);
      return view(found);
    },
    async getIssue(issueId) {
      authed();
      const found = issue(issueId);
      return { ...view(found), description: found.description };
    },
    async relate(blockingId, blockedId) {
      authed();
      issue(blockingId);
      issue(blockedId);
      store.relations.push({ blocking: blockingId, blocked: blockedId });
    },
    async comment(issueId, body) {
      authed();
      issue(issueId).comments.push(body);
    },
    async issuesWithLabel({ teamId, labelId, projectId, since }) {
      authed();
      team(teamId);
      return store.issues
        .filter((i) => i.labelIds.includes(labelId))
        .filter((i) => !projectId || i.projectId === projectId)
        .filter((i) => !since || new Date(i.updatedAt) >= since)
        .map(view);
    },
    move(identifier, stateName) {
      const found = store.issues.find((i) => i.identifier === identifier);
      const to = SCRIPTED_STATES.find((s) => s.name === stateName);
      if (!found || !to) throw new Error(`No issue ${identifier} or status ${stateName}`);
      found.state = { ...to };
      touch(found);
      return view(found);
    },
  };
}

/** Puts a label on an issue the way a person would in Linear (tests, D44). */
export function addScriptedLabel(
  store: ReturnType<typeof scriptedStore>,
  identifier: string,
  name: string,
) {
  let label = store.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!label) {
    label = { id: `lbl_${store.labels.length + 1}`, name, teamId: SCRIPTED_TEAM.id };
    store.labels.push(label);
  }
  const issue = store.issues.find((i) => i.identifier === identifier);
  if (!issue) throw new Error(`No issue ${identifier}`);
  if (!issue.labelIds.includes(label.id)) issue.labelIds.push(label.id);
  issue.updatedAt = new Date().toISOString();
}
