/**
 * Signing in without pasting (D47): the GitHub CLI's own sign-in, asked for a token each time
 * and storing nothing; and Sign in with Linear, OAuth with PKCE, renewed before it expires and
 * revoked on sign-out. A fake `gh` and a fake Linear token endpoint stand in; no test needs
 * GitHub or Linear.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import {
  chooseGhCli,
  forgeReady,
  forgeToken,
  getForge,
  getForgeSettings,
  GhCliError,
  removeForgeKey,
  saveForgeKey,
  useForgeFactory,
} from '@/lib/forge';
import { forgetGh } from '@/lib/forge/gh-cli';
import { scriptedForge, scriptedForgeStore } from '@/lib/forge/scripted';
import { linearTracker } from '@/lib/tracker/linear';
import {
  finishLinearSignIn,
  getLinearSettings,
  getTracker,
  linearView,
  removeLinearKey,
  saveLinearClientId,
  saveLinearKey,
  startLinearSignIn,
  useTrackerFactory,
  type LinearKeyKind,
} from '@/lib/tracker';
import { LINEAR_REVOKE_URL, LINEAR_TOKEN_URL, useLinearOAuthFetch } from '@/lib/tracker/oauth';
import { scriptedStore, scriptedTracker } from '@/lib/tracker/scripted';

const SECRET = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

/** A fake `gh` that answers `auth token` from a file, and counts how often it was asked. */
function fakeGh(dir: string): { bin: string; setToken(t: string | null): void; calls(): number } {
  const bin = path.join(dir, 'gh');
  const tokenFile = path.join(dir, 'token');
  const countFile = path.join(dir, 'count');
  fs.writeFileSync(countFile, '');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo x >> "${countFile}"
if [ "$1 $2" != "auth token" ]; then echo "unexpected: $*" >&2; exit 2; fi
if [ ! -s "${tokenFile}" ]; then echo "no oauth token found for github.com" >&2; exit 1; fi
cat "${tokenFile}"
`,
    { mode: 0o755 },
  );
  return {
    bin,
    setToken(token) {
      fs.writeFileSync(tokenFile, token ? `${token}\n` : '');
    },
    calls: () => fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length,
  };
}

describe('the GitHub CLI’s sign-in', () => {
  let db: Db;
  let close: () => Promise<void>;
  let dir: string;
  let gh: ReturnType<typeof fakeGh>;
  const previous = { key: process.env.MAGPIPE_SECRET_KEY, gh: process.env.MAGPIPE_GH_PATH };
  const tokensSeen: string[] = [];

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-gh-'));
    gh = fakeGh(dir);
    process.env.MAGPIPE_GH_PATH = gh.bin;
    forgetGh();
    useForgeFactory((token) => {
      tokensSeen.push(token);
      return scriptedForge(token, scriptedForgeStore(true));
    });
    ({ db, close } = await openDb('memory://'));
  });
  afterAll(async () => {
    useForgeFactory(undefined);
    forgetGh();
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ['MAGPIPE_SECRET_KEY', previous.key],
      ['MAGPIPE_GH_PATH', previous.gh],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is refused while the CLI is signed out, and changes nothing', async () => {
    gh.setToken(null);
    await expect(chooseGhCli(db)).rejects.toMatchObject({
      code: 'signed_out',
      message: expect.stringContaining('gh auth login'),
    });
    expect((await getForgeSettings(db)).keySource).toBe('token');
  });

  it('uses the CLI’s token once GitHub accepts it, storing none, and replaces a pasted token', async () => {
    await saveForgeKey(db, 'ghp_pasted_1234');
    expect(await db.select().from(t.secrets)).toHaveLength(1);

    gh.setToken('gho_from_cli');
    const settings = await chooseGhCli(db);
    expect(settings).toMatchObject({
      keySource: 'gh',
      keyRef: null,
      keyHint: null,
      viewer: 'scripted-operator',
    });
    // The pasted token is gone; nothing of the CLI's is kept.
    expect(await db.select().from(t.secrets)).toHaveLength(0);
    expect(tokensSeen.at(-1)).toBe('gho_from_cli');

    // A project's repository with the CLI's sign-in is ready, and calls go with its token.
    const withRepo = { ...settings, repo: 'o/app' };
    expect(forgeReady(withRepo)).toBe(true);
    const { forge, repo } = await getForge(db, withRepo);
    await forge.repository(repo);
    expect(tokensSeen.at(-1)).toBe('gho_from_cli');
  });

  it('asks the CLI again only after a while, and a project’s own token comes first', async () => {
    const asked = gh.calls();
    const s = await getForgeSettings(db);
    expect(await forgeToken(db, s)).toBe('gho_from_cli');
    expect(await forgeToken(db, s)).toBe('gho_from_cli');
    expect(gh.calls()).toBe(asked);

    // A sealed token, as a project carries its own, is used instead of the CLI's.
    await saveForgeKey(db, 'ghp_project_own');
    const own = await getForgeSettings(db);
    expect(own.keySource).toBe('token');
    expect(await forgeToken(db, own)).toBe('ghp_project_own');
  });

  it('stopping clears the choice, and a missing CLI is named', async () => {
    gh.setToken('gho_from_cli');
    await chooseGhCli(db);
    const stopped = await removeForgeKey(db);
    expect(stopped).toMatchObject({ keySource: 'token', keyRef: null, viewer: null });
    expect(forgeReady({ ...stopped, repo: 'o/app' })).toBe(false);

    process.env.MAGPIPE_GH_PATH = path.join(dir, 'no-such-gh');
    forgetGh();
    // The machine running the tests may have a real gh on its PATH; only a missing one is named.
    const err = await chooseGhCli(db).catch((e: unknown) => e);
    if (err instanceof GhCliError && err.code === 'missing') {
      expect(err.message).toContain('cli.github.com');
    }
    process.env.MAGPIPE_GH_PATH = gh.bin;
    forgetGh();
  });
});

describe('Sign in with Linear', () => {
  let db: Db;
  let close: () => Promise<void>;
  const store = scriptedStore(true);
  const previous = process.env.MAGPIPE_SECRET_KEY;
  const kinds: LinearKeyKind[] = [];
  const keys: string[] = [];
  /** What the fake token endpoint was sent, and what it answers next. */
  const sent: { url: string; form: URLSearchParams; auth: string | null }[] = [];
  let answer: () => Response = () => new Response(null, { status: 500 });
  let n = 0;
  const tokens = () => {
    n++;
    return Response.json({
      access_token: `lin_oauth_${n}`,
      refresh_token: `lin_refresh_${n}`,
      token_type: 'Bearer',
      expires_in: 86_399,
      scope: 'read,write',
    });
  };

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    useTrackerFactory((key, kind = 'key') => {
      kinds.push(kind);
      keys.push(key);
      return scriptedTracker(key, store);
    });
    useLinearOAuthFetch(async (input, init) => {
      const url = String(input);
      sent.push({
        url,
        form: new URLSearchParams(String(init?.body ?? '')),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return url === LINEAR_REVOKE_URL ? new Response(null, { status: 200 }) : answer();
    });
    ({ db, close } = await openDb('memory://'));
  });
  afterEach(() => {
    answer = () => new Response(null, { status: 500 });
  });
  afterAll(async () => {
    useTrackerFactory(undefined);
    useLinearOAuthFetch(undefined);
    await close();
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('needs an OAuth app, then sends the browser to Linear with PKCE', async () => {
    await expect(startLinearSignIn(db, 'http://localhost:3210')).rejects.toThrow(
      'Sign in with Linear needs an OAuth app',
    );
    expect(linearView(await getLinearSettings(db)).signInClientId).toBeNull();
    await saveLinearClientId(db, '  client_abc123  ');
    expect(linearView(await getLinearSettings(db)).signInClientId).toBe('client_abc123');

    const { url, redirectUri } = await startLinearSignIn(db, 'http://localhost:3210');
    expect(redirectUri).toBe('http://localhost:3210/api/linear-callback');
    const params = new URL(url).searchParams;
    expect(url.startsWith('https://linear.app/oauth/authorize?')).toBe(true);
    expect(Object.fromEntries(params)).toMatchObject({
      client_id: 'client_abc123',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read,write',
      code_challenge_method: 'S256',
    });
    expect(params.get('state')!.length).toBeGreaterThan(20);
    expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  });

  it('refuses a callback it did not start, and each state is used once', async () => {
    await expect(finishLinearSignIn(db, { code: 'c', state: 'made-up' })).rejects.toThrow(
      'This sign-in was not started here',
    );
    const { url } = await startLinearSignIn(db, 'http://localhost:3210');
    const params = new URL(url).searchParams;
    answer = tokens;
    await finishLinearSignIn(db, { code: 'code_1', state: params.get('state')! });
    await expect(
      finishLinearSignIn(db, { code: 'code_1', state: params.get('state')! }),
    ).rejects.toThrow('This sign-in was not started here');
  });

  it('trades the code with the PKCE verifier, checks the token, and keeps it sealed as a Bearer sign-in', async () => {
    await saveLinearKey(db, 'lin_api_pasted_before');
    const pasted = (await getLinearSettings(db)).keyRef!;
    const { url } = await startLinearSignIn(db, 'http://localhost:3210');
    const params = new URL(url).searchParams;
    answer = tokens;
    sent.length = 0;
    const settings = await finishLinearSignIn(db, { code: 'code_2', state: params.get('state')! });

    const exchange = sent.find((r) => r.url === LINEAR_TOKEN_URL)!;
    expect(Object.fromEntries(exchange.form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code_2',
      client_id: 'client_abc123',
      redirect_uri: 'http://localhost:3210/api/linear-callback',
    });
    // The verifier sent is the one whose hash went out with the sign-in.
    const verifier = exchange.form.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      params.get('code_challenge'),
    );
    expect(settings).toMatchObject({
      keyKind: 'oauth',
      keyHint: null,
      viewer: 'Scripted Operator',
    });
    expect(settings.refreshRef).not.toBeNull();
    expect(settings.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
    // The pasted key it replaced is gone.
    const refs = (await db.select({ id: t.secrets.id }).from(t.secrets)).map((r) => r.id);
    expect(refs).not.toContain(pasted);
    expect(refs).toEqual(expect.arrayContaining([settings.keyRef, settings.refreshRef]));

    // Calls go with the access token, as a Bearer token.
    kinds.length = 0;
    await (await getTracker(db)).viewer();
    expect(kinds).toEqual(['oauth']);
    expect(keys.at(-1)).toBe(`lin_oauth_${n}`);
  });

  it('sends the access token as a Bearer token, and a pasted key as it is', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ data: { viewer: { name: 'A' } } });
    }) as unknown as typeof fetch;
    await linearTracker({ token: 'lin_oauth_x', bearer: true }, fetchImpl).viewer();
    await linearTracker('lin_api_y', fetchImpl).viewer();
    expect(seen).toEqual(['Bearer lin_oauth_x', 'lin_api_y']);
  });

  it('renews the token once when it is about to expire, however many calls find it due', async () => {
    const before = await getLinearSettings(db);
    await db.update(t.linearSettings).set({ expiresAt: new Date(Date.now() + 60_000) });
    answer = tokens;
    sent.length = 0;
    keys.length = 0;
    await Promise.all([getTracker(db), getTracker(db), getTracker(db)]);
    const refreshes = sent.filter((r) => r.form.get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.form.get('client_id')).toBe('client_abc123');
    const after = await getLinearSettings(db);
    expect(after.keyRef).not.toBe(before.keyRef);
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
    expect(new Set(keys)).toEqual(new Set([`lin_oauth_${n}`]));
    // The old pair is let go once the new one is stored.
    const refs = (await db.select({ id: t.secrets.id }).from(t.secrets)).map((r) => r.id);
    expect(refs).not.toContain(before.keyRef);
    expect(refs).not.toContain(before.refreshRef);
    expect(refs.sort()).toEqual([after.keyRef, after.refreshRef].sort());
  });

  it('a refused renewal asks the operator to sign in again', async () => {
    await db.update(t.linearSettings).set({ expiresAt: new Date(Date.now() + 60_000) });
    answer = () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    await expect(getTracker(db)).rejects.toMatchObject({ code: 'auth' });
    expect((await getLinearSettings(db)).lastError).toBe(
      'The Linear sign-in expired. Sign in with Linear again in Settings.',
    );
  });

  it('signing out revokes the token with Linear and forgets both', async () => {
    const token = keys.at(-1);
    sent.length = 0;
    const settings = await removeLinearKey(db);
    expect(settings).toMatchObject({
      keyKind: 'key',
      keyRef: null,
      refreshRef: null,
      viewer: null,
    });
    const revoke = sent.find((r) => r.url === LINEAR_REVOKE_URL);
    expect(revoke?.auth).toBe(`Bearer ${token}`);
    expect(await db.select().from(t.secrets)).toHaveLength(0);
  });
});
