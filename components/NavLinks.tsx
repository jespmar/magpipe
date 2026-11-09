'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { Logo } from './Logo';
import { isActive, NAV_LINKS } from '@/lib/nav';

/**
 * Logo + wordmark, linking home. Home has no entry in the nav list (per the design), so the
 * brand is the Home affordance: it carries `aria-current` and the same cyan underline as an
 * active link when you are there, and a hover underline the rest of the time.
 */
export function BrandLink() {
  const home = usePathname() === '/';
  return (
    <Link
      href="/"
      aria-current={home ? 'page' : undefined}
      className="group flex min-w-0 items-center gap-2.5 text-ink-strong"
    >
      <Logo onDisc size={24} discSize={36} id="mp-wing-nav" label={null} />
      <span
        className={clsx(
          'border-b-2 pb-0.5 text-body-md font-semibold transition-colors',
          home ? 'border-cyan' : 'border-transparent group-hover:border-hairline',
        )}
      >
        Magpipe
      </span>
      {/* The pause keeps the accessible name from reading "Magpipeagent orchestrator". */}
      <span className="sr-only">, </span>
      <span className="ml-1 hidden text-caption font-medium text-mute sm:inline">
        agent orchestrator
      </span>
    </Link>
  );
}

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={clsx('flex items-center gap-5 md:gap-6', className)}>
      {NAV_LINKS.map(({ href, label }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              // py-1.5 lifts the hit area to ≥32 px without changing the visual rhythm much.
              'border-b-2 py-1.5 text-body-sm transition-colors',
              active
                ? 'border-cyan font-semibold text-ink-strong'
                : 'border-transparent text-body hover:text-ink-strong',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
