/**
 * This app's own origin as the browser reached it (D47): where Linear sends the browser back
 * after Sign in with Linear. The desktop app answers on localhost and its Host header is checked
 * (middleware), so forwarded headers are ignored there; a hosted app behind a proxy names its
 * public host and protocol in them, of which only the first value counts.
 */
type HeaderBag = { get(name: string): string | null };

function first(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

export function originFrom(h: HeaderBag, opts: { desktop: boolean }): string {
  const host =
    (opts.desktop ? null : first(h.get('x-forwarded-host'))) ?? first(h.get('host')) ?? 'localhost';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto =
    (opts.desktop ? null : first(h.get('x-forwarded-proto'))) ?? (local ? 'http' : 'https');
  return `${proto}://${host}`;
}
