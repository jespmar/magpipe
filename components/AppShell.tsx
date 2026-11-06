import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './Logo';
import { NavLinks } from './NavLinks';
import { LivePill } from './ui/LivePill';
import { ButtonLink } from './ui/Button';
import { getShellData } from '@/lib/shell-data';
import { dbDir } from '@/lib/db';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';

/** Nav, footer and ambient background shared by every signed-in screen (spec §3.1). */
export async function AppShell({ children }: { children: ReactNode }) {
  const shell = await getShellData();

  return (
    <div className="flex min-h-dvh flex-col ambient text-ink">
      <header
        data-titlebar
        className="sticky top-0 z-40 border-b border-[rgba(34,193,220,0.28)] glass"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8 wide:px-12">
          <Link href="/" className="flex items-center gap-2.5 text-ink-strong">
            <Logo onDisc size={24} discSize={36} id="mp-wing-nav" label={null} />
            <span className="text-body-md font-semibold">Magpipe</span>
            <span className="ml-1 hidden text-caption font-medium text-mute sm:inline">
              agent orchestrator
            </span>
          </Link>
          <NavLinks />
          <div className="flex items-center gap-3">
            <LivePill count={shell.activeAgents} />
            <ButtonLink href="/settings" variant="outline" className="py-2 leading-6">
              Settings
            </ButtonLink>
          </div>
        </div>
      </header>

      {shell.dbError ? <DbBanner message={shell.dbError} /> : null}

      <main className="shell-container flex flex-1 flex-col gap-7 pt-12 pb-10">{children}</main>

      <footer className="flex flex-wrap justify-between gap-3 border-t border-hairline px-4 py-6 text-body-sm text-body md:px-8 wide:px-12">
        <span>Magpipe · agent orchestrator</span>
        <span className="font-mono text-code text-mute">
          v{VERSION} · {shell.region}
        </span>
      </footer>
    </div>
  );
}

function DbBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="border-b border-[rgba(251,191,36,0.35)] bg-[rgba(251,191,36,0.06)]"
    >
      <p className="shell-container py-2.5 text-body-sm text-ink">
        <span className="font-semibold text-warn">The database could not be opened.</span> {message}{' '}
        Data lives in <code className="font-mono text-code">{dbDir()}</code>.
      </p>
    </div>
  );
}
