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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import {
  chooseGhCli,
  forgeReady,
  forgeToken,
  getForge,
  getForgeSettings,
  refreshCliViewer,
  removeForgeKey,
  saveForgeKey,
  useForgeFactory,
} from '@/lib/forge';
import { forgetGh, onlyGhPathSetting } from '@/lib/forge/gh-cli';
import { deleteSecret, readSecret, storeSecret } from '@/lib/secrets';
import { originFrom } from '@/lib/request-origin';
import { GET } from '@/app/api/linear-callback/route';
import { scriptedForge, scriptedForgeStore } from '@/lib/forge/scripted';
import { linearTracker } from '@/lib/tracker/linear';
import {
  cancelLinearSignIn,
  finishLinearSignIn,
  getLinearSettings,
  linearSignInOutcome,
  refuseLinearSignIn,
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
  /** Tokens GitHub no longer takes, and who each token signs in as. */
  const refused = new Set<string>();
  const logins: Record<string, string> = {};

  beforeAll(async () => {
    process.env.MAGPIPE_SECRET_KEY = SECRET;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpipe-gh-'));
    gh = fakeGh(dir);
    process.env.MAGPIPE_GH_PATH = gh.bin;
    // Only the fake: a real gh on the machine running the tests is never found or called.
    onlyGhPathSetting(true);
    useForgeFactory((token) => {
      tokensSeen.push(token);
      const forge = scriptedForge(
        refused.has(token) ? 'ghp_bad_refused' : token,
        scriptedForgeStore(true),
      );
      return {
        ...forge,
        viewer: async () => ({ login: logins[token] ?? (await forge.viewer()).login }),
      };
    });
    ({ db, close } = await openDb('memory://'));
  });
  afterAll(async () => {
    useForgeFactory(undefined);
    onlyGhPathSetting(false);
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

    // A project's own token is sealed and comes first, while the workspace uses the CLI.
    const ref = await storeSecret(db, 'ghp_project_own');
    expect(await forgeToken(db, { keySource: 'gh', keyRef: ref })).toBe('ghp_project_own');
    expect(gh.calls()).toBe(asked);
    await deleteSecret(db, ref);
  });

  it('asks the CLI again when GitHub refuses its token, and Settings shows who it is now', async () => {
    // The operator switched gh to another account: the cached token is refused.
    refused.add('gho_from_cli');
    gh.setToken('gho_second');
    logins.gho_second = 'second-account';
    const s = { ...(await getForgeSettings(db)), repo: 'o/app' };
    const { forge, repo } = await getForge(db, s);
    await expect(forge.repository(repo)).resolves.toEqual({ defaultBranch: 'main' });
    expect(tokensSeen.slice(-2)).toEqual(['gho_from_cli', 'gho_second']);
    // Settings reads who the CLI is signed in as and keeps it current.
    expect(s.viewer).toBe('scripted-operator');
    const shown = await refreshCliViewer(db, await getForgeSettings(db));
    expect(shown.viewer).toBe('second-account');
    expect((await getForgeSettings(db)).viewer).toBe('second-account');
  });

  it('stopping clears the choice, and a missing CLI is named', async () => {
    gh.setToken('gho_second');
    await chooseGhCli(db);
    const stopped = await removeForgeKey(db);
    expect(stopped).toMatchObject({ keySource: 'token', keyRef: null, viewer: null });
    expect(forgeReady({ ...stopped, repo: 'o/app' })).toBe(false);

    // No gh: named, and a pasted token stays as it was.
    await saveForgeKey(db, 'ghp_kept_5678');
    const kept = await getForgeSettings(db);
    process.env.MAGPIPE_GH_PATH = path.join(dir, 'no-such-gh');
    forgetGh();
    await expect(chooseGhCli(db)).rejects.toMatchObject({
      code: 'missing',
      message: expect.stringContaining('cli.github.com'),
    });
    expect(await getForgeSettings(db)).toMatchObject({ keySource: 'token', keyRef: kept.keyRef });
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
  let answer: () => Response | Promise<Response> = () => new Response(null, { status: 500 });
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

  it('a renewal that cannot reach Linear keeps the current token while it works, and the next call renews', async () => {
    const current = await readSecret(db, (await getLinearSettings(db)).keyRef!);
    await db
      .update(t.linearSettings)
      .set({ expiresAt: new Date(Date.now() + 5 * 60_000), lastError: null });
    answer = () => new Response(null, { status: 503 });
    keys.length = 0;
    await getTracker(db);
    expect(keys.at(-1)).toBe(current);
    // The failed renewal is not remembered: the next call tries again, and renews.
    answer = tokens;
    sent.length = 0;
    await getTracker(db);
    expect(sent.filter((r) => r.form.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(keys.at(-1)).toBe(`lin_oauth_${n}`);
  });

  it('renews with the OAuth app the tokens came from, and keeps the refresh token when Linear sends none', async () => {
    await saveLinearClientId(db, 'client_changed_since');
    const before = await getLinearSettings(db);
    const refresh = await readSecret(db, before.refreshRef!);
    await db.update(t.linearSettings).set({ expiresAt: new Date(Date.now() + 60_000) });
    answer = () => {
      n++;
      return Response.json({ access_token: `lin_oauth_${n}`, expires_in: 86_399 });
    };
    sent.length = 0;
    await getTracker(db);
    const renewal = sent.find((r) => r.form.get('grant_type') === 'refresh_token')!;
    expect(renewal.form.get('client_id')).toBe('client_abc123');
    const after = await getLinearSettings(db);
    expect(await readSecret(db, after.keyRef!)).toBe(`lin_oauth_${n}`);
    expect(await readSecret(db, after.refreshRef!)).toBe(refresh);
    await saveLinearClientId(db, 'client_abc123');
  });

  it('a renewal under way does not bring back a sign-in replaced meanwhile: its pair is revoked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answer = async () => {
      await gate;
      return tokens();
    };
    await db.update(t.linearSettings).set({ expiresAt: new Date(Date.now() + 60_000) });
    sent.length = 0;
    const renewing = getTracker(db);
    await vi.waitFor(() =>
      expect(sent.some((r) => r.form.get('grant_type') === 'refresh_token')).toBe(true),
    );
    // Meanwhile the sign-in is replaced underneath it, as another window pasting a key would
    // (which lets go of the pair it replaces).
    const replaced = await getLinearSettings(db);
    const other = await storeSecret(db, 'lin_api_other_window');
    await db.update(t.linearSettings).set({ keyKind: 'key', keyRef: other, refreshRef: null });
    for (const ref of [replaced.keyRef, replaced.refreshRef]) if (ref) await deleteSecret(db, ref);
    release();
    await expect(renewing).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('signed out while'),
    });
    expect((await getLinearSettings(db)).keyRef).toBe(other);
    const revoked = sent.filter((r) => r.url === LINEAR_REVOKE_URL).map((r) => r.form.get('token'));
    expect(revoked).toEqual(expect.arrayContaining([`lin_oauth_${n}`, `lin_refresh_${n}`]));
    // Nothing of the renewed pair is kept.
    const kept = await Promise.all(
      (await db.select({ id: t.secrets.id }).from(t.secrets)).map((r) => readSecret(db, r.id)),
    );
    expect(kept).not.toContain(`lin_oauth_${n}`);
  });

  it('says how each sign-in ended, and a sign-in left open cannot finish once cancelled or replaced', async () => {
    const origin = 'http://localhost:3210';
    const refused = await startLinearSignIn(db, origin);
    expect(linearSignInOutcome(refused.state)).toEqual({ status: 'waiting' });
    expect(refuseLinearSignIn(refused.state, 'access_denied')).toBe(
      'Magpipe was not allowed in Linear. You can try again from Settings.',
    );
    expect(linearSignInOutcome(refused.state)).toEqual({
      status: 'failed',
      message: 'Magpipe was not allowed in Linear. You can try again from Settings.',
    });

    const cancelled = await startLinearSignIn(db, origin);
    cancelLinearSignIn(cancelled.state);
    expect(linearSignInOutcome(cancelled.state)).toEqual({ status: 'gone' });
    await expect(finishLinearSignIn(db, { code: 'c', state: cancelled.state })).rejects.toThrow(
      'This sign-in was not started here',
    );

    // Tokens that cannot be kept are revoked: here Linear refuses the new token's viewer check.
    const broken = await startLinearSignIn(db, origin);
    answer = () =>
      Response.json({
        access_token: 'lin_api_bad_issued',
        refresh_token: 'lin_refresh_bad_issued',
        expires_in: 86_399,
      });
    sent.length = 0;
    await expect(finishLinearSignIn(db, { code: 'c', state: broken.state })).rejects.toMatchObject({
      code: 'auth',
    });
    expect(sent.filter((r) => r.url === LINEAR_REVOKE_URL).map((r) => r.form.get('token'))).toEqual(
      ['lin_api_bad_issued', 'lin_refresh_bad_issued'],
    );
    expect(linearSignInOutcome(broken.state)).toMatchObject({ status: 'failed' });

    // A pasted key ends every sign-in still open.
    const open = await startLinearSignIn(db, origin);
    await saveLinearKey(db, 'lin_api_pasted_now');
    expect(linearSignInOutcome(open.state)).toEqual({ status: 'gone' });

    const done = await startLinearSignIn(db, origin);
    answer = tokens;
    await finishLinearSignIn(db, { code: 'c', state: done.state });
    expect(linearSignInOutcome(done.state)).toEqual({
      status: 'done',
      viewer: 'Scripted Operator',
    });
  });

  it('forgets a sign-in after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const late = await startLinearSignIn(db, 'http://localhost:3210');
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
      await expect(finishLinearSignIn(db, { code: 'c', state: late.state })).rejects.toThrow(
        'took longer than ten minutes',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('signing out waits for a renewal under way, then revokes both tokens and forgets them', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answer = async () => {
      await gate;
      return tokens();
    };
    await db.update(t.linearSettings).set({ expiresAt: new Date(Date.now() + 60_000) });
    sent.length = 0;
    const renewing = getTracker(db);
    await vi.waitFor(() =>
      expect(sent.some((r) => r.form.get('grant_type') === 'refresh_token')).toBe(true),
    );
    const signingOut = removeLinearKey(db);
    release();
    await renewing;
    const settings = await signingOut;
    expect(settings).toMatchObject({
      keyKind: 'key',
      keyRef: null,
      refreshRef: null,
      tokenClientId: null,
      viewer: null,
    });
    // The pair the renewal stored is the one revoked: nothing is left live or kept.
    const revokes = sent.filter((r) => r.url === LINEAR_REVOKE_URL);
    expect(revokes.map((r) => [r.form.get('token'), r.form.get('token_type_hint')])).toEqual([
      [`lin_oauth_${n}`, 'access_token'],
      [`lin_refresh_${n}`, 'refresh_token'],
    ]);
    expect(revokes[0]!.auth).toBe(`Bearer lin_oauth_${n}`);
    expect(await db.select().from(t.secrets)).toHaveLength(0);
  });
});

describe('the address Linear comes back to', () => {
  const bag = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

  it('is the desktop app’s own host, ignoring forwarded headers there', () => {
    expect(originFrom(bag({ host: '127.0.0.1:3457' }), { desktop: true })).toBe(
      'http://127.0.0.1:3457',
    );
    expect(
      originFrom(bag({ host: 'localhost:3457', 'x-forwarded-host': 'evil.example' }), {
        desktop: true,
      }),
    ).toBe('http://localhost:3457');
  });

  it('is a hosted app’s public host, the first of several forwarded values', () => {
    expect(
      originFrom(
        bag({
          host: 'internal:3000',
          'x-forwarded-host': 'magpipe.example, proxy.internal',
          'x-forwarded-proto': 'https, http',
        }),
        { desktop: false },
      ),
    ).toBe('https://magpipe.example');
    expect(originFrom(bag({ host: 'magpipe.example' }), { desktop: false })).toBe(
      'https://magpipe.example',
    );
    expect(originFrom(bag({ host: '[::1]:3000' }), { desktop: false })).toBe('http://[::1]:3000');
  });

  it('answers a refusal with a fixed message, never what the address says', async () => {
    const res = await GET(
      new Request(
        'http://localhost:3457/api/linear-callback?error=access_denied&error_description=Re-enter%20your%20token%20at%20evil.example&state=nope',
      ),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Magpipe was not allowed in Linear.');
    expect(html).not.toContain('evil.example');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const bare = await GET(new Request('http://localhost:3457/api/linear-callback'));
    expect(bare.status).toBe(400);
    expect(await bare.text()).toContain('This address is only for Linear to come back to.');
  });
});
