import { clsx } from 'clsx';

export type ButtonVariant = 'primary' | 'run' | 'outline' | 'soft' | 'ghost';
export type ButtonSize = 'sm' | 'md';

/**
 * Button looks from the design: the primary is solid white (never a colour), `run` is the
 * white→tint gradient with a cyan glow used by the prompt's Run button.
 */
export function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md') {
  return clsx(
    'inline-flex items-center justify-center gap-2 rounded-sm font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'run'
      ? 'px-4 py-2 text-button'
      : size === 'sm'
        ? 'px-3 py-1.5 text-button-sm'
        : 'px-4 py-2.5 text-button-sm',
    {
      primary: 'bg-accent text-on-accent shadow-glow-soft hover:bg-tint',
      run: 'bg-(image:--g-button) text-on-accent shadow-glow',
      outline: 'border border-hairline bg-canvas text-ink hover:border-ghost',
      soft: 'border border-hairline bg-canvas-soft text-ink hover:border-ghost',
      ghost: 'border border-transparent bg-canvas text-ghost hover:text-ink-strong',
    }[variant],
  );
}
