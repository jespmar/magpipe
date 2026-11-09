import type { ReactNode } from 'react';
import { BrandLink, NavLinks } from './NavLinks';
import { LivePill } from './ui/LivePill';
import { ButtonLink } from './ui/Button';
import { RetryButton } from './ui/RetryButton';
import { getShellData, type DbError } from '@/lib/shell-data';
import { dataDir } from '@/lib/db';
import { isDesktop } from '@/lib/env';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

/** Nav, footer and ambient background shared by every signed-in screen (spec §3.1). */
export async function AppShell({ children }: { children: ReactNode }) {
  const shell = await getShellData();
  // A region label only means something when one was configured; the desktop app is just that.
  const regionLabel = isDesktop && shell.region === 'local' ? 'desktop' : shell.region;

  return (
    <div className="flex min-h-dvh flex-col ambient text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:text-button-sm focus:font-semibold focus:text-on-accent"
      >
        Skip to content
      </a>

      {/* Static on phones (three rows would eat the viewport), sticky from tablet up. */}
      <header
        data-titlebar
        className="z-40 border-b border-[rgba(34,193,220,0.28)] glass md:sticky md:top-0"
      >
        <div className="shell-container grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 md:flex md:justify-between">
          <BrandLink />
          <NavLinks className="col-span-2 row-start-2 md:col-span-1 md:row-auto" />
          <div className="col-start-2 row-start-1 flex items-center gap-3 md:col-auto md:row-auto">
            <LivePill count={shell.activeAgents} />
            <ButtonLink href="/settings" variant="outline" className="py-2 leading-6">
              Settings
            </ButtonLink>
          </div>
        </div>
      </header>

      {shell.dbError ? <DbBanner error={shell.dbError} /> : null}

      <main
        id="main"
        tabIndex={-1}
        className="shell-container flex flex-1 flex-col gap-7 pt-12 pb-10 focus:outline-none"
      >
        {children}
      </main>

      <footer className="border-t border-hairline py-6 text-body-sm text-body">
        <div className="shell-container flex flex-wrap justify-between gap-3">
          <span>Magpipe · agent orchestrator</span>
          <span className="font-mono text-code text-mute">
            v{VERSION} · {regionLabel}
          </span>
        </div>
      </footer>
    </div>
  );
}

function DbBanner({ error }: { error: DbError }) {
  const locked = error.kind === 'locked';
  return (
    <div
      role="status"
      className="border-b border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.06)]"
    >
      <div className="shell-container flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2.5 text-body-sm text-ink">
        <p className="max-w-[31rem]">
          <span className="font-semibold text-warn">
            {locked
              ? 'Another Magpipe window is using this data folder.'
              : 'Magpipe can’t open its database.'}
          </span>{' '}
          {locked ? 'Close it, then try again.' : error.message}{' '}
          <span className="text-body">
            Data folder:{' '}
            <code className="font-mono text-code break-all text-ink select-all">{dataDir()}</code>
          </span>
        </p>
        <RetryButton />
      </div>
    </div>
  );
}
