/**
 * Who may use this server (docs/decisions.md D4). Edge-safe: no Node APIs here.
 *
 * - `desktop` — the Electron app. Every request must carry the per-launch token that only the
 *   app window holds (cookie, or `x-magpipe-token` from the main process). No sign-in.
 * - `open`    — `MAGPIPE_AUTH_DISABLED=true`: local dev and e2e tests. Ignored on Vercel.
 * - `signin`  — Auth.js (GitHub). For a hosted deployment.
 */
export type AccessMode = 'desktop' | 'open' | 'signin';

export const DESKTOP_COOKIE = 'magpipe_desktop';
export const DESKTOP_HEADER = 'x-magpipe-token';

export function desktopToken(): string | undefined {
  return process.env.MAGPIPE_DESKTOP_TOKEN || undefined;
}

export function accessMode(): AccessMode {
  if (desktopToken()) return 'desktop';
  const flag = process.env.MAGPIPE_AUTH_DISABLED;
  if ((flag === 'true' || flag === '1') && !process.env.VERCEL) return 'open';
  return 'signin';
}

export const LOCAL_USER = {
  id: 'local',
  name: 'Local user',
  email: null,
  image: null,
} as const;
