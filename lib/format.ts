/** Small, locale-aware formatters shared by screens. Pure; tested in tests/format.test.ts. */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "4 minutes ago", "yesterday", "3 days ago", "2 weeks ago", else a short date. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diffSec / 86_400), 'day');
  if (abs < 30 * 86_400) return rtf.format(Math.round(diffSec / (7 * 86_400)), 'week');
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(date);
}

/** `mm:ss`, or `h:mm:ss` from an hour up — the flight-table convention (spec §3.4). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 950 → "950", 42_000 → "42k", 1_400_000 → "1.4M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** `plural(1, 'bird')` → "1 bird", `plural(4, 'bird')` → "4 birds"; irregulars pass `many`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
