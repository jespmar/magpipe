import { clsx } from 'clsx';

/** Mono initials on a hairline disc: the agent's face everywhere, and a tool's glyph. */
export function Avatar({
  initials,
  size = 36,
  className,
}: {
  initials: string;
  size?: 24 | 36 | 40 | 44;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-pill border border-hairline bg-canvas-soft font-mono font-medium text-ink-strong',
        size === 44 ? 'text-code' : 'text-caption',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}
