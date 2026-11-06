import Link from 'next/link';
import type { ComponentProps } from 'react';
import { clsx } from 'clsx';
import { buttonClass, type ButtonSize, type ButtonVariant } from './button-styles';

type Common = { variant?: ButtonVariant; size?: ButtonSize };

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: Common & ComponentProps<'button'>) {
  return <button type={type} className={clsx(buttonClass(variant, size), className)} {...props} />;
}

/** A link that looks like a button — use for navigation (e.g. "+ Add a bird" → /agents?new=1). */
export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: Common & ComponentProps<typeof Link>) {
  return <Link className={clsx(buttonClass(variant, size), className)} {...props} />;
}
