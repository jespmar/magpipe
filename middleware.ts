import { timingSafeEqual } from 'node:crypto';
import NextAuth from 'next-auth';
import {
  NextResponse,
  type NextFetchEvent,
  type NextMiddleware,
  type NextRequest,
} from 'next/server';
import { authConfig } from './auth.config';
import { accessMode, DESKTOP_COOKIE, DESKTOP_HEADER, desktopToken } from './lib/auth-mode';

const { auth } = NextAuth(authConfig);

function deny(req: NextRequest, status: number, message: string) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: { code: 'forbidden', message } }, { status });
  }
  return new NextResponse(message, { status, headers: { 'content-type': 'text/plain' } });
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Desktop: only the app window may talk to the server. The Host check defeats DNS rebinding;
 * the token (a session cookie set by the Electron main process) keeps out every other local
 * program and every web page open in a normal browser.
 */
function desktopGate(req: NextRequest, token: string) {
  const host = (req.headers.get('host') ?? '').toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return deny(req, 421, 'Unexpected host.');
  }
  const supplied = req.cookies.get(DESKTOP_COOKIE)?.value ?? req.headers.get(DESKTOP_HEADER) ?? '';
  if (!sameSecret(supplied, token)) {
    return deny(req, 403, 'This Magpipe server only answers its own desktop window.');
  }
  return NextResponse.next();
}

// Auth.js types the wrapped handler as a route handler; at runtime it is a middleware.
const requireSession = auth((req) => {
  if (req.auth?.user) return;

  const { pathname, search } = req.nextUrl;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Sign in required' } },
      { status: 401 },
    );
  }
  const url = new URL('/signin', req.nextUrl);
  url.searchParams.set('callbackUrl', pathname + search);
  return NextResponse.redirect(url);
}) as unknown as NextMiddleware;

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  switch (accessMode()) {
    case 'desktop':
      return desktopGate(req, desktopToken()!);
    case 'open':
      // Never touches Auth.js, so it also works without AUTH_SECRET.
      return NextResponse.next();
    case 'signin':
      return requireSession(req, event);
  }
}

export const config = {
  // Node runtime (stable in Next 15.5): the desktop server is Node anyway, and it avoids
  // jose's Edge-incompatible CompressionStream warnings from Auth.js.
  runtime: 'nodejs',
  // Public: Auth.js routes, the health probe (Electron boot + uptime checks), the sign-in
  // page, static assets.
  matcher: [
    '/((?!api/auth|api/health|signin|_next/static|_next/image|brand|icon.svg|favicon.ico).*)',
  ],
};
