/**
 * Keyboard shortcuts (spec §10, PR 8). One list feeds the handler, the `?` sheet and Settings.
 * Single keys fire only outside text fields; `g` opens a one-second chord for the screen letters.
 */
export type Shortcut = { keys: readonly string[]; label: string; chord?: boolean };

export const GO_TO: Readonly<Record<string, { href: string; label: string }>> = {
  h: { href: '/', label: 'Home' },
  a: { href: '/agents', label: 'Agents' },
  r: { href: '/runs', label: 'Runs' },
  t: { href: '/tools', label: 'Tools' },
  m: { href: '/memory', label: 'Memory' },
  s: { href: '/settings', label: 'Settings' },
};

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['?'], label: 'Show the keyboard shortcuts' },
  { keys: ['/'], label: 'Focus the search on this screen' },
  { keys: ['n'], label: 'New run: go home with the prompt ready' },
  ...Object.entries(GO_TO).map(([key, to]) => ({
    keys: ['g', key],
    label: `Go to ${to.label}`,
    chord: true,
  })),
  { keys: ['⌘ / Ctrl', 'Enter'], label: 'Run the task in the prompt window' },
  { keys: ['Esc'], label: 'Close a dialog' },
];

/** Typing contexts where single-key shortcuts must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
