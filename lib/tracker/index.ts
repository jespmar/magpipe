/**
 * Linear access for the factory (D38): the settings row, the sealed key, and the tracker built
 * from them. The key is checked against Linear before it is stored, stored sealed like a tool's
 * token (D13), and never read back out to a screen. The mapping is read back from Linear when it
 * is saved, so a wrong team or status is named then, not at the first spec.
 */
import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { env } from '../env';
import { deleteSecret, readSecret, storeSecret } from '../secrets';
import {
  pipelineStates,
  type LinearMappingInput,
  type LinearSettings,
  type PipelineState,
  type PipelineStateMap,
  type TrackerRef,
  type TrackerTeam,
  type WatcherInput,
} from '../schemas';
import { PIPELINE_LABELS } from './labels';
import { linearTracker } from './linear';
import { scriptedTracker } from './scripted';
import { TrackerError, type Tracker, type TrackerState } from './types';

export { TrackerError } from './types';
export type { RemoteIssue, Tracker, TrackerState } from './types';

export { PIPELINE_LABELS } from './labels';

export const DEFAULT_LABEL = 'magpipe';
export const DEFAULT_POLL_SECONDS = 60;

const DEFAULTS: Omit<LinearSettings, 'updatedAt'> = {
  id: 'linear',
  keyRef: null,
  keyHint: null,
  viewer: null,
  team: null,
  label: null,
  states: {},
  pollSeconds: DEFAULT_POLL_SECONDS,
  paused: false,
  lastCheckAt: null,
  lastCheck: null,
  lastError: null,
};

// ─── the tracker ───────────────────────────────────────────────────────────

type TrackerFactory = (apiKey: string) => Tracker;

const g = globalThis as unknown as { __magpipeTrackerFactory?: TrackerFactory };

/** Linear, or the scripted tracker when the environment asks for it outside production. */
function defaultFactory(apiKey: string): Tracker {
  if (env.MAGPIPE_TRACKER_STUB === 'scripted' && process.env.NODE_ENV !== 'production') {
    return scriptedTracker(apiKey);
  }
  return linearTracker(apiKey);
}

/** Tests swap the tracker; `undefined` puts Linear back. */
export function useTrackerFactory(factory: TrackerFactory | undefined): void {
  g.__magpipeTrackerFactory = factory;
}

export function trackerFor(apiKey: string): Tracker {
  return (g.__magpipeTrackerFactory ?? defaultFactory)(apiKey);
}

/** Linear is set up when it has a key, a team, a label and all six statuses. */
export function linearReady(
  s: Pick<LinearSettings, 'keyRef' | 'team' | 'label' | 'states'>,
): boolean {
  return Boolean(s.keyRef && s.team && s.label && pipelineStates.every((p) => s.states[p]));
}

export class LinearNotReadyError extends Error {
  readonly code = 'linear_not_ready';
}

/** The tracker for the saved key. */
export async function getTracker(db: Db, settings?: LinearSettings): Promise<Tracker> {
  const s = settings ?? (await getLinearSettings(db));
  const key = s.keyRef ? await readSecret(db, s.keyRef) : null;
  if (!key) throw new LinearNotReadyError('No Linear API key is saved. Add one in Settings.');
  return trackerFor(key);
}

// ─── the settings row ──────────────────────────────────────────────────────

export async function getLinearSettings(db: Db): Promise<LinearSettings> {
  const [row] = await db.select().from(t.linearSettings).where(eq(t.linearSettings.id, 'linear'));
  return row ?? { ...DEFAULTS, updatedAt: new Date(0) };
}

async function writeLinear(
  db: Db,
  patch: Partial<Omit<LinearSettings, 'id'>>,
): Promise<LinearSettings> {
  const now = new Date();
  const [row] = await db
    .insert(t.linearSettings)
    .values({ ...DEFAULTS, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: t.linearSettings.id, set: { ...patch, updatedAt: now } })
    .returning();
  return row!;
}

/** What Settings shows: everything but the key, and whether the factory can file issues. */
export type LinearView = Omit<LinearSettings, 'keyRef'> & { hasKey: boolean; ready: boolean };

export function linearView(s: LinearSettings): LinearView {
  const { keyRef, ...rest } = s;
  return { ...rest, hasKey: keyRef !== null, ready: linearReady(s) };
}

/**
 * Saves a pasted key once Linear accepts it, replacing any key before it. Returns who it belongs
 * to and the teams it can see, for the mapping.
 */
export async function saveLinearKey(
  db: Db,
  apiKey: string,
): Promise<{ settings: LinearSettings; teams: TrackerTeam[] }> {
  const key = apiKey.trim();
  const tracker = trackerFor(key);
  const viewer = await tracker.viewer();
  const teams = await tracker.teams();
  const before = await getLinearSettings(db);
  const keyRef = await storeSecret(db, key);
  const settings = await writeLinear(db, {
    keyRef,
    keyHint: key.slice(-4),
    viewer: viewer.name,
    lastError: null,
  });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return { settings, teams };
}

/** Forgets the key. The mapping stays, so a new key picks up where this one left off. */
export async function removeLinearKey(db: Db): Promise<LinearSettings> {
  const before = await getLinearSettings(db);
  const settings = await writeLinear(db, { keyRef: null, keyHint: null, viewer: null });
  if (before.keyRef) await deleteSecret(db, before.keyRef);
  return settings;
}

/**
 * A first guess at which of the team's statuses each pipeline state is, by name and then by
 * Linear's status type. The operator changes what is wrong.
 */
export function suggestStates(states: readonly TrackerState[]): Record<PipelineState, string> {
  const taken = new Set<string>();
  /** The first free status matching the names in order of preference, then by type. */
  const pick = (byName: RegExp[], types: string[], fallback = true): string => {
    const free = states.filter((s) => !taken.has(s.id));
    let found: TrackerState | undefined;
    for (const re of byName) {
      found = free.find((s) => re.test(s.name));
      if (found) break;
    }
    found ??= free.find((s) => types.includes(s.type)) ?? (fallback ? free[0] : undefined);
    if (found) taken.add(found.id);
    return found?.id ?? '';
  };
  // Done and the needs-you status first, so the started statuses are left for building.
  const done = pick([/^done$/i, /complete/i], ['completed']);
  const needsYou = pick([/blocked/i, /needs/i, /hold|waiting/i], [], false);
  const specReady = pick([/spec/i, /triage/i, /backlog/i], ['triage', 'backlog']);
  const approved = pick([/approved/i, /^to ?do$/i, /ready/i], ['unstarted']);
  const merge = pick([/review/i, /merge/i], [], false);
  const building = pick([/progress/i, /building|doing/i], ['started']);
  return {
    spec_ready: specReady,
    approved,
    building,
    merge_question: merge || pick([], ['started']),
    done,
    needs_you: needsYou || pick([], ['started', 'canceled']),
  };
}

/** The teams the saved key can see, and the statuses of one of them with a first guess. */
export async function linearOptions(
  db: Db,
  teamId?: string,
): Promise<{
  teams: TrackerTeam[];
  states: TrackerState[];
  suggested: Record<PipelineState, string> | null;
}> {
  const tracker = await getTracker(db);
  const teams = await tracker.teams();
  const states = teamId ? await tracker.states(teamId) : [];
  return { teams, states, suggested: teamId ? suggestStates(states) : null };
}

/** A mapping Linear does not hold, or two states on one status. */
export class LinearMappingError extends Error {
  readonly code = 'validation';
}

/**
 * Saves the team, the label (made in Linear when it is missing) and the six statuses, after
 * reading them back from Linear. Returns what the read-back found, for the result line.
 */
/**
 * Reads a mapping back from Linear (D38, D45): the team the key can see, each pipeline state on a
 * status of its own, and the label (made when missing). Throws what is wrong in the operator's
 * words; writes nothing.
 */
export async function readBackMapping(
  tracker: Tracker,
  input: Pick<LinearMappingInput, 'teamId' | 'label'> & { states: Record<string, string> },
): Promise<{
  team: TrackerTeam;
  states: PipelineStateMap;
  label: TrackerRef & { created: boolean };
  statuses: number;
}> {
  const team = (await tracker.teams()).find((x) => x.id === input.teamId);
  if (!team) throw new LinearMappingError('The key cannot see that team any more. Pick another.');
  const states = await tracker.states(team.id);
  const map: PipelineStateMap = {};
  const used = new Map<string, PipelineState>();
  for (const p of pipelineStates) {
    const found = states.find((s) => s.id === input.states[p]);
    if (!found) {
      throw new LinearMappingError(
        `${team.name} has no status for ${PIPELINE_LABELS[p]} any more. Pick one again.`,
      );
    }
    const clash = used.get(found.id);
    if (clash) {
      throw new LinearMappingError(
        `${PIPELINE_LABELS[clash]} and ${PIPELINE_LABELS[p]} both use ${found.name}. Each state needs its own status; add one in Linear if the team has too few.`,
      );
    }
    used.set(found.id, p);
    map[p] = { id: found.id, name: found.name };
  }
  const label = await tracker.ensureLabel(team.id, input.label);
  return { team, states: map, label, statuses: states.length };
}

/**
 * Saves the team, the label and the six statuses after reading them back from Linear. Since
 * projects (D45) this is the default project's mapping; the row keeps a copy for the default
 * project to start from.
 */
export async function saveLinearMapping(
  db: Db,
  input: LinearMappingInput,
): Promise<{ settings: LinearSettings; labelCreated: boolean; statuses: number }> {
  const read = await readBackMapping(await getTracker(db), input);
  // The next check reads every labelled issue again, so each takes its stage from this mapping.
  const settings = await writeLinear(db, {
    team: read.team,
    label: { id: read.label.id, name: read.label.name },
    states: read.states,
    lastError: null,
    lastCheckAt: null,
  });
  return { settings, labelCreated: read.label.created, statuses: read.statuses };
}

export async function saveWatcher(db: Db, input: WatcherInput): Promise<LinearSettings> {
  return writeLinear(db, { pollSeconds: input.pollSeconds, paused: input.paused });
}

/**
 * Records what a check found, for Settings. A failed check leaves `lastCheckAt` at the last one
 * that worked, so the next good check reaches back over the whole outage.
 */
export async function recordCheck(
  db: Db,
  result: { at: Date; issues: number; changed: number } | { error: string },
): Promise<void> {
  await writeLinear(
    db,
    'error' in result
      ? { lastError: result.error }
      : {
          lastCheckAt: result.at,
          lastCheck: { issues: result.issues, changed: result.changed },
          lastError: null,
        },
  );
}

/** A tracker failure in the operator's words. */
export function trackerMessage(err: unknown): string {
  if (err instanceof TrackerError || err instanceof LinearNotReadyError) return err.message;
  return `Linear could not be reached: ${err instanceof Error ? err.message : String(err)}`;
}
