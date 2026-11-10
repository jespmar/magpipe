import Link from 'next/link';
import type { ComponentProps, Ref } from 'react';
import { clsx } from 'clsx';
import {
  Button as ArcButton,
  type ButtonProps as ArcButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from '@/components/arc/button/button';
import styles from '@/components/arc/button/button.module.css';

export type { ButtonSize, ButtonVariant };
export type ButtonProps = ArcButtonProps & { ref?: Ref<HTMLButtonElement> };

/**
 * Arc's button. The default here is `secondary`, not Arc's `primary`: one primary action per
 * surface is a decision, so it is always written out. `loading` shows the spinner, keeps the
 * label's width and swallows clicks while keeping focus.
 */
export function Button({ variant = 'secondary', type = 'button', ...props }: ButtonProps) {
  return <ArcButton variant={variant} type={type} {...props} />;
}

type Look = { variant?: ButtonVariant; size?: ButtonSize };

/** A link that looks like the button, for navigation ("New run", "Load demo data"). */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: Look & ComponentProps<typeof Link>) {
  return (
    <Link className={clsx(styles.button, styles[variant], styles[size], className)} {...props} />
  );
}
