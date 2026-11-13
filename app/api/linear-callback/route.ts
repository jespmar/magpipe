import { getDb } from '@/lib/db';
import { accessMode } from '@/lib/auth-mode';
import { finishLinearSignIn, LinearSignInError, trackerMessage } from '@/lib/tracker';

export const dynamic = 'force-dynamic';

/**
 * GET /api/linear-callback?code=&state= — where Linear sends the browser back after Sign in
 * with Linear (D47). Public, since the system browser carries no desktop cookie: what keeps it
 * safe is the state, which must be one this server started in the last ten minutes, used once,
 * and the PKCE verifier only this server holds. The page it answers with is for that browser
 * tab; the Magpipe window sees the sign-in on its own.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  // Desktop: the same Host check as every other request (DNS rebinding).
  if (accessMode() === 'desktop') {
    const host = (req.headers.get('host') ?? '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return page('Unexpected host.', 421);
    }
  }
  const denied = url.searchParams.get('error');
  if (denied) {
    const why = url.searchParams.get('error_description') ?? denied;
    return page(
      `Linear did not sign you in: ${why}. You can close this tab and try again from Magpipe.`,
      400,
    );
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return page('This address is only for Linear to come back to.', 400);
  try {
    const settings = await finishLinearSignIn(await getDb(), { code, state });
    return page(
      `Signed in to Linear${settings.viewer ? ` as ${settings.viewer}` : ''}. You can close this tab and go back to Magpipe.`,
      200,
    );
  } catch (err) {
    const message = err instanceof LinearSignInError ? err.message : trackerMessage(err);
    if (!(err instanceof LinearSignInError)) console.error('[linear sign-in] failed:', err);
    return page(`${message} You can close this tab.`, 400);
  }
}

/** A plain page for the browser tab: the app's colours, no scripts, nothing to follow. */
function page(message: string, status: number): Response {
  const text = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magpipe</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#ededed;font:16px/1.5 system-ui,sans-serif;padding:16px}p{max-width:34rem}</style></head><body><main><p role="status">${text}</p></main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
      },
    },
  );
}
