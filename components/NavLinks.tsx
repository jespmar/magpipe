'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { isActive, NAV_LINKS } from '@/lib/nav';

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-6">
      {NAV_LINKS.map(({ href, label }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'border-b-2 pb-0.5 text-body-sm transition-colors',
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
