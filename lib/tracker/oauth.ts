/**
 * Sign in with Linear (D47): OAuth 2.0 with PKCE, so the desktop app needs an OAuth app's client
 * ID and no secret. This file is the protocol only: the sign-in address, the code exchange, the
 * refresh and the revocation. Storing the tokens and renewing them is `lib/tracker/index.ts`'s.
 * Tests swap the HTTP (`useLinearOAuthFetch`), and the scripted tracker's stand-in Linear answers
 * the exchange itself, so no test needs Linear.
 */
import { createHash, randomBytes } from 'node:crypto';
import { TrackerError } from './types';

export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/** What the factory needs: read the team's issues, write issues, comments and relations. */
export const LINEAR_SCOPES = 'read,write';

/** The path Linear sends the browser back to, on Magpipe's own origin. */
export const LINEAR_CALLBACK_PATH = '/api/linear-callback';

export type LinearTokens = {
  accessToken: string;
  /** Present for OAuth apps made since October 2025; older apps issue long-lived tokens. */
  refreshToken: string | null;
  /** When the access token stops working; null when Linear did not say. */
  expiresAt: Date | null;
};

const g = globalThis as unknown as { __magpipeLinearOAuthFetch?: typeof fetch };

/** Tests swap the HTTP; `undefined` puts fetch back. */
export function useLinearOAuthFetch(impl: typeof fetch | undefined): void {
  g.__magpipeLinearOAuthFetch = impl;
}

/** The HTTP for one call: a test's, else the one given (the scripted stand-in), else fetch. */
function http(given?: typeof fetch): typeof fetch {
  return g.__magpipeLinearOAuthFetch ?? given ?? fetch;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** A PKCE pair: the verifier kept on the server, the S256 challenge sent with the sign-in. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

/** The address the browser opens: Linear asks the operator to allow Magpipe, then comes back. */
export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: LINEAR_SCOPES,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
    actor: 'user',
  }).toString();
  return url.toString();
}

type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  form: Record<string, string>,
  fetchImpl?: typeof fetch,
): Promise<LinearTokens> {
  let res: Response;
  try {
    res = await http(fetchImpl)(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TrackerError(`Linear could not be reached: ${(err as Error).message}`, 'network');
  }
  let body: TokenAnswer = {};
  try {
    body = (await res.json()) as TokenAnswer;
  } catch {
    // not JSON: the status says enough
  }
  if (!res.ok || !body.access_token) {
    // invalid_grant: the code was used or expired, or the refresh token is no longer good.
    if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
      throw new TrackerError(
        `Linear did not accept the sign-in${body.error_description ? `: ${body.error_description}` : ''}. Sign in with Linear again in Settings.`,
        'auth',
      );
    }
    throw new TrackerError(
      `Linear answered ${res.status} to the sign-in.`,
      res.status >= 500 ? 'network' : 'unknown',
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt:
      typeof body.expires_in === 'number' ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

/** Trades the code Linear sent back for tokens, proving the sign-in started here (PKCE). */
export function exchangeCode(
  input: { clientId: string; redirectUri: string; code: string; verifier: string },
  fetchImpl?: typeof fetch,
): Promise<LinearTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    },
    fetchImpl,
  );
}

/** A new access token from the refresh token, before the old one expires. */
export function refreshTokens(
  input: { clientId: string; refreshToken: string },
  fetchImpl?: typeof fetch,
): Promise<LinearTokens> {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: input.refreshToken, client_id: input.clientId },
    fetchImpl,
  );
}

/** Tells Linear the token is no longer wanted. Best effort: signing out never waits on it. */
export async function revokeToken(accessToken: string, fetchImpl?: typeof fetch): Promise<void> {
  try {
    await http(fetchImpl)(LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // already gone, or Linear out of reach: the token is forgotten here either way
  }
}

/**
 * The scripted tracker's stand-in for Linear's sign-in (development and tests only): the
 * browser comes straight back with this code, and the exchange gives a scripted token.
 */
export const SCRIPTED_OAUTH_CODE = 'scripted_code';

export const scriptedOAuthFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === LINEAR_REVOKE_URL) return new Response(null, { status: 200 });
  const form = new URLSearchParams(String(init?.body ?? ''));
  const ok =
    (form.get('grant_type') === 'authorization_code' &&
      form.get('code') === SCRIPTED_OAUTH_CODE &&
      Boolean(form.get('code_verifier'))) ||
    (form.get('grant_type') === 'refresh_token' &&
      (form.get('refresh_token') ?? '').startsWith('lin_refresh_scripted'));
  if (!ok) {
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  const n = randomBytes(4).toString('hex');
  return Response.json({
    access_token: `lin_oauth_scripted_${n}`,
    refresh_token: `lin_refresh_scripted_${n}`,
    token_type: 'Bearer',
    expires_in: 86_399,
    scope: LINEAR_SCOPES,
  });
};
