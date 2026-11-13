/**
 * Linear access for the factory (D38): the settings row, the sealed key, and the tracker built
 * from them. The key is checked against Linear before it is stored, stored sealed like a tool's
 * token (D13), and never read back out to a screen. The mapping is read back from Linear when it
 * is saved, so a wrong team or status is named then, not at the first spec.
 */
import 'server-only';
import { eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../db';
import * as t from '../db/schema';
import { env } from '../env';
import { deleteSecret, readSecret, storeSecret } from '../secrets';
import {
  pipelineStates,
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
import {
  authorizeUrl,
  exchangeCode,
  LINEAR_CALLBACK_PATH,
  pkcePair,
  randomState,
  refreshTokens,
  revokeToken,
  SCRIPTED_OAUTH_CODE,
  scriptedOAuthFetch,
  type LinearTokens,
} from './oauth';
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
  keyKind: 'key',
  refreshRef: null,
  expiresAt: null,
  oauthClientId: null,
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

/** How the key came (D47): a personal API key, or Sign in with Linear's access token. */
export type LinearKeyKind = LinearSettings['keyKind'];

type TrackerFactory = (apiKey: string, kind?: LinearKeyKind) => Tracker;

const g = globalThis as unknown as { __magpipeTrackerFactory?: TrackerFactory };

/** Linear, or the scripted tracker when the environment asks for it outside production. */
function defaultFactory(apiKey: string, kind: LinearKeyKind = 'key'): Tracker {
  if (scripted()) return scriptedTracker(apiKey);
  return linearTracker(kind === 'oauth' ? { token: apiKey, bearer: true } : apiKey);
}

/** The scripted tracker stands in for Linear, sign-in included, outside production only. */
function scripted(): boolean {
  return env.MAGPIPE_TRACKER_STUB === 'scripted' && process.env.NODE_ENV !== 'production';
}

/** Tests swap the tracker; `undefined` puts Linear back. */
export function useTrackerFactory(factory: TrackerFactory | undefined): void {
  g.__magpipeTrackerFactory = factory;
}

export function trackerFor(apiKey: string, kind: LinearKeyKind = 'key'): Tracker {
  return (g.__magpipeTrackerFactory ?? defaultFactory)(apiKey, kind);
}

/**
 * Linear is set up when it has a key, a team, a label and all six statuses. For a project these
 * come from the project (`projectLinear`, D46); the workspace row holds only the key and watcher.
 */
export function linearReady(
  s: Pick<LinearSettings, 'keyRef' | 'team' | 'label' | 'states'>,
): boolean {
  return Boolean(s.keyRef && s.team && s.label && pipelineStates.every((p) => s.states[p]));
}

export class LinearNotReadyError extends Error {
  readonly code = 'linear_not_ready';
}

/** The tracker for the saved key, or the signed-in token, renewed first when it is due (D47). */
export async function getTracker(db: Db, settings?: LinearSettings): Promise<Tracker> {
  const s = settings ?? (await getLinearSettings(db));
  const key = await linearToken(db, s);
  if (!key) {
    throw new LinearNotReadyError(
      'Linear is not connected. Sign in with Linear or add a key in Settings.',
    );
  }
  return trackerFor(key, s.keyKind);
}

/** An access token is renewed when it has less than this left. */
const RENEW_BEFORE_MS = 10 * 60_000;

/**
 * The credential to call Linear with: a key as saved, or the signed-in access token, renewed
 * with the refresh token when it is close to expiring. One renewal at a time: two checks that
 * both find the token due share the one renewal, since Linear may retire a refresh token once
 * it is used.
 */
async function linearToken(db: Db, s: LinearSettings): Promise<string | null> {
  if (!s.keyRef) return null;
  if (s.keyKind !== 'oauth' || !s.expiresAt || !s.refreshRef) return readSecret(db, s.keyRef);
  if (s.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) return readSecret(db, s.keyRef);
  oauthState().renewing ??= renewSignIn(db).finally(() => {
    oauthState().renewing = undefined;
  });
  return oauthState().renewing!;
}

/** Renews the signed-in token, storing the new pair before the old one is let go. */
async function renewSignIn(db: Db): Promise<string> {
  const s = await getLinearSettings(db);
  // Another renewal may have finished first: its token is good.
  if (s.keyKind !== 'oauth' || !s.keyRef) {
    throw new TrackerError('Linear is no longer signed in. Sign in again in Settings.', 'auth');
  }
  if (s.expiresAt && s.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) {
    return (await readSecret(db, s.keyRef))!;
  }
  const clientId = s.oauthClientId ?? env.MAGPIPE_LINEAR_CLIENT_ID;
  const refreshToken = s.refreshRef ? await readSecret(db, s.refreshRef) : null;
  if (!clientId || !refreshToken) {
    throw new TrackerError(
      'The Linear sign-in cannot be renewed. Sign in again in Settings.',
      'auth',
    );
  }
  let tokens: LinearTokens;
  try {
    tokens = await refreshTokens({ clientId, refreshToken }, oauthHttp());
  } catch (err) {
    if (err instanceof TrackerError && err.code === 'auth') {
      await writeLinear(db, {
        lastError: 'The Linear sign-in expired. Sign in with Linear again in Settings.',
      });
    }
    throw err;
  }
  await storeSignIn(db, s, tokens, s.viewer);
  return tokens.accessToken;
}

/** Writes a signed-in token pair, then lets go of the pair before it (D47). */
async function storeSignIn(
  db: Db,
  before: LinearSettings,
  tokens: LinearTokens,
  viewer: string | null,
): Promise<LinearSettings> {
  const keyRef = await storeSecret(db, tokens.accessToken);
  const refreshRef = tokens.refreshToken ? await storeSecret(db, tokens.refreshToken) : null;
  const settings = await writeLinear(db, {
    keyKind: 'oauth',
    keyRef,
    keyHint: null,
    refreshRef,
    expiresAt: tokens.expiresAt,
    viewer,
    lastError: null,
  });
  for (const ref of [before.keyRef, before.refreshRef]) {
    if (ref && ref !== keyRef && ref !== refreshRef) await deleteSecret(db, ref);
  }
  return settings;
}

// ─── Sign in with Linear (D47) ─────────────────────────────────────────────

type Pending = { verifier: string; redirectUri: string; clientId: string; at: number };
type OAuthState = { pending: Map<string, Pending>; renewing?: Promise<string> };

function oauthState(): OAuthState {
  const holder = globalThis as unknown as { __magpipeLinearOAuth?: OAuthState };
  holder.__magpipeLinearOAuth ??= { pending: new Map() };
  return holder.__magpipeLinearOAuth;
}

/** A sign-in started and not finished in this long is forgotten. */
const SIGN_IN_MS = 10 * 60_000;

/** The scripted stand-in answers the sign-in's HTTP outside production (tests swap their own). */
function oauthHttp(): typeof fetch | undefined {
  return scripted() ? scriptedOAuthFetch : undefined;
}

export class LinearSignInError extends Error {
  readonly code = 'validation';
}

/**
 * Starts Sign in with Linear: a one-time state and PKCE pair kept here, and the address the
 * browser opens. `origin` is this app's own, where Linear sends the browser back.
 */
export async function startLinearSignIn(
  db: Db,
  origin: string,
): Promise<{ url: string; redirectUri: string }> {
  const s = await getLinearSettings(db);
  const clientId = s.oauthClientId ?? env.MAGPIPE_LINEAR_CLIENT_ID;
  if (!clientId) {
    throw new LinearSignInError(
      'Sign in with Linear needs an OAuth app. Add its client ID here first, or paste a personal API key.',
    );
  }
  const redirectUri = new URL(LINEAR_CALLBACK_PATH, origin).toString();
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const { pending } = oauthState();
  for (const [k, p] of pending) if (Date.now() - p.at > SIGN_IN_MS) pending.delete(k);
  pending.set(state, { verifier, redirectUri, clientId, at: Date.now() });
  // The stand-in comes straight back, as if the operator allowed it at once.
  const url = scripted()
    ? `${redirectUri}?${new URLSearchParams({ code: SCRIPTED_OAUTH_CODE, state })}`
    : authorizeUrl({ clientId, redirectUri, state, challenge });
  return { url, redirectUri };
}

/**
 * Finishes Sign in with Linear when the browser comes back: the state must be one started here
 * and not yet used, the code is traded for tokens with the PKCE verifier, the token is checked
 * with Linear, and only then stored, sealed, in place of any key before it.
 */
export async function finishLinearSignIn(
  db: Db,
  input: { code: string; state: string },
): Promise<LinearSettings> {
  const { pending } = oauthState();
  const started = pending.get(input.state);
  pending.delete(input.state);
  if (!started || Date.now() - started.at > SIGN_IN_MS) {
    throw new LinearSignInError(
      'This sign-in was not started here, or took longer than ten minutes. Start it again from Settings.',
    );
  }
  const tokens = await exchangeCode(
    {
      clientId: started.clientId,
      redirectUri: started.redirectUri,
      code: input.code,
      verifier: started.verifier,
    },
    oauthHttp(),
  );
  const viewer = await trackerFor(tokens.accessToken, 'oauth').viewer();
  const before = await getLinearSettings(db);
  return storeSignIn(db, before, tokens, viewer.name);
}

/** Saves the OAuth app's client ID for Sign in with Linear (public: PKCE needs no secret). */
export async function saveLinearClientId(db: Db, clientId: string | null): Promise<LinearSettings> {
  return writeLinear(db, { oauthClientId: clientId?.trim() || null });
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

/**
 * Whether any factory project carries a Linear key of its own: Settings shows Check now then too
 * (D46). Read here, not through lib/projects, so Settings stays light to compile.
 */
export async function anyProjectLinearKey(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: t.factoryProjects.id })
    .from(t.factoryProjects)
    .where(isNotNull(t.factoryProjects.linearKeyRef))
    .limit(1);
  return row !== undefined;
}

/**
 * What Settings shows: everything but the key and the refresh token. `ready` means a check can
 * run: there is a key. `signInClientId` is the OAuth app Sign in with Linear uses (D47): the one
 * Settings holds, else magpipe.env's, else none.
 */
export type LinearView = Omit<LinearSettings, 'keyRef' | 'refreshRef'> & {
  hasKey: boolean;
  ready: boolean;
  signInClientId: string | null;
};

export function linearView(s: LinearSettings): LinearView {
  const { keyRef, refreshRef: _refresh, ...rest } = s;
  return {
    ...rest,
    hasKey: keyRef !== null,
    ready: keyRef !== null,
    signInClientId: s.oauthClientId ?? env.MAGPIPE_LINEAR_CLIENT_ID ?? null,
  };
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
    keyKind: 'key',
    keyRef,
    keyHint: key.slice(-4),
    refreshRef: null,
    expiresAt: null,
    viewer: viewer.name,
    lastError: null,
  });
  for (const ref of [before.keyRef, before.refreshRef]) if (ref) await deleteSecret(db, ref);
  return { settings, teams };
}

/**
 * Forgets the key, or signs out of Linear (D47): a signed-in token is revoked with Linear first,
 * best effort. Projects keep their mapping, so a new key picks up where this one left off.
 */
export async function removeLinearKey(db: Db): Promise<LinearSettings> {
  const before = await getLinearSettings(db);
  if (before.keyKind === 'oauth' && before.keyRef) {
    const token = await readSecret(db, before.keyRef);
    if (token) await revokeToken(token, oauthHttp());
  }
  const settings = await writeLinear(db, {
    keyKind: 'key',
    keyRef: null,
    keyHint: null,
    refreshRef: null,
    expiresAt: null,
    viewer: null,
  });
  for (const ref of [before.keyRef, before.refreshRef]) if (ref) await deleteSecret(db, ref);
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

/** A mapping Linear does not hold, or two states on one status. */
export class LinearMappingError extends Error {
  readonly code = 'validation';
}

/**
 * Reads a mapping back from Linear (D38, D45): the team the key can see, each pipeline state on a
 * status of its own, and the label (made when missing). Throws what is wrong in the operator's
 * words; writes nothing.
 */
export async function readBackMapping(
  tracker: Tracker,
  input: { teamId: string; label: string; states: Record<string, string> },
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
