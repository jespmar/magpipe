import { ButtonLink } from './Button';

/** The one real next step on a fresh workspace: jump to the demo-data section of Settings. */
export function DemoLink({ variant = 'outline' }: { variant?: 'outline' | 'ghost' }) {
  return (
    <ButtonLink href="/settings#demo" variant={variant}>
      Load demo data
    </ButtonLink>
  );
}
