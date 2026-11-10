import type { ReactNode } from 'react';
import { Alert } from '@/components/arc/alert/alert';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { BrandLink, NavLinks } from './NavLinks';
import { LivePill } from './ui/LivePill';
import { ButtonLink } from './ui/Button';
import { RetryButton } from './ui/RetryButton';
import { getShellData, type DbError } from '@/lib/shell-data';
import { dataDir } from '@/lib/db';
import { isDesktop } from '@/lib/env';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

/** Nav, footer and the one page container shared by every signed-in screen (spec §3.1). */
export async function AppShell({ children }: { children: ReactNode }) {
  const shell = await getShellData();
  // A region label only means something when one was configured; the desktop app is just that.
  const regionLabel = isDesktop && shell.region === 'local' ? 'desktop' : shell.region;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-ink-strong focus:px-3 focus:py-2 focus:text-body-sm focus:font-medium focus:text-canvas"
      >
        Skip to content
      </a>

      {/* Static on phones (three rows would eat the viewport), sticky from tablet up. */}
      <header
        data-titlebar
        className="z-40 border-b border-hairline-soft bg-canvas md:sticky md:top-0"
      >
        <div className="shell-container grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 md:flex md:justify-between">
          <BrandLink />
          <NavLinks className="col-span-2 row-start-2 md:col-span-1 md:row-auto" />
          <div className="col-start-2 row-start-1 flex items-center gap-2 md:col-auto md:row-auto">
            <LivePill count={shell.activeAgents} />
            <ButtonLink href="/settings" variant="ghost" size="sm">
              Settings
            </ButtonLink>
          </div>
        </div>
      </header>

      {shell.dbError ? <DbBanner error={shell.dbError} /> : null}
      <KeyboardShortcuts />

      <main
        id="main"
        tabIndex={-1}
        className="shell-container flex flex-1 flex-col gap-6 pt-8 pb-12 focus:outline-none"
      >
        {children}
      </main>

      <footer className="border-t border-hairline-soft py-6 text-body-sm text-body">
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
    <div className="shell-container pt-6">
      <Alert
        tone="warning"
        title={
          locked
            ? 'Another Magpipe window is using this data folder'
            : 'Magpipe can’t open its database'
        }
      >
        <span className="flex flex-col gap-2">
          <span>{locked ? 'Close it, then try again.' : error.message}</span>
          {/* The path is a token, not prose: wrap only where it must, never mid-word by default. */}
          <span className="[overflow-wrap:anywhere]">
            Data folder:{' '}
            <code className="font-mono text-code text-ink select-all">{dataDir()}</code>
          </span>
          <span className="pt-1">
            <RetryButton />
          </span>
        </span>
      </Alert>
    </div>
  );
}
