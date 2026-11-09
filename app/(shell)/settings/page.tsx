import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import { PageHead } from '@/components/ui/PageHead';
import { Button } from '@/components/ui/Button';
import { DemoDataForm } from '@/components/settings/DemoDataForm';
import { dataDir, getDb } from '@/lib/db';
import { settings as settingsTable } from '@/lib/db/schema';
import { buildSeed } from '@/lib/db/seed-data';
import { env } from '@/lib/env';
import { accessMode } from '@/lib/auth-mode';
import { currentUser } from '@/lib/session';
import { getShellData } from '@/lib/shell-data';
import type { Settings } from '@/lib/schemas';

export const metadata: Metadata = { title: 'Settings' };

async function loadSettings(): Promise<Settings | null> {
  try {
    const [row] = await (await getDb()).select().from(settingsTable).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

const MODE_LABEL = {
  desktop: 'desktop app, no sign-in',
  open: 'sign-in disabled for development',
  signin: 'signed in with GitHub',
} as const;

/** Read-only facts for now (spec §3.7); editing lands with the screen that first needs it. */
export default async function SettingsPage() {
  const [settings, user, shell] = await Promise.all([
    loadSettings(),
    currentUser(),
    getShellData(),
  ]);
  const mode = accessMode();
  const dash = '—';
  const seed = buildSeed();
  const demoCounts = {
    tools: seed.tools.length,
    memory: seed.memory.length,
    runs: seed.runs.length,
  };

  return (
    <>
      <PageHead eyebrow="Workspace" title="Settings" />

      <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start wide:max-w-[1600px]">
        <Section id="workspace" title="Workspace" className="md:row-span-2">
          <p className="text-body-sm text-body">
            Read-only for now — editing these lands with the screens that need them.
          </p>
          <Facts
            title="Identity"
            rows={[
              ['Name', settings?.workspaceName ?? dash],
              ['Region label', env.MAGPIPE_REGION ?? settings?.region ?? dash],
              ['Spend cap per day', settings ? `$${settings.spendCapUsd.toFixed(2)}` : dash],
            ]}
          />
          <Facts
            title="Models"
            rows={[
              ['Orchestrator', settings?.models.orchestrator ?? dash],
              ['Default for new birds', settings?.models.default ?? dash],
            ]}
          />
          <Facts
            title="Storage"
            rows={[
              ['Data folder', dataDir()],
              ...(env.MAGPIPE_CONFIG_PATH
                ? [['Config file', env.MAGPIPE_CONFIG_PATH] as const]
                : []),
            ]}
            note="Everything Magpipe knows lives in the data folder. To back up, copy it while Magpipe is closed."
          />
        </Section>

        <Section id="demo" title="Demo data">
          <p className="text-body-sm text-body">
            Example tools, memory and finished flights from the design, so every screen has
            something to show. Loading it again refreshes the examples and leaves your own data
            alone.
          </p>
          <DemoDataForm
            counts={demoCounts}
            disabledReason={
              shell.dbError
                ? 'Needs the database — see the notice at the top of the page.'
                : undefined
            }
          />
        </Section>

        <Section id="access" title="Access">
          <p className="text-body-md text-ink-strong">
            {user?.name ?? user?.email ?? 'Unknown'}
            <span className="text-mute"> · {MODE_LABEL[mode]}</span>
          </p>
          {mode === 'signin' ? (
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/signin' });
              }}
            >
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          ) : null}
        </Section>
      </div>
    </>
  );
}

function Section({
  id,
  title,
  className,
  children,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      // scroll-mt clears the sticky header when linked as /settings#demo
      className={`flex scroll-mt-24 flex-col gap-5 rounded-md border border-hairline bg-(image:--g-card) p-6 ${className ?? ''}`}
    >
      <h2 id={`${id}-title`} className="text-display-sm text-ink-strong">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({
  title,
  rows,
  note,
}: {
  title: string;
  rows: ReadonlyArray<readonly [string, string]>;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="label-caps">{title}</h3>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-[180px_minmax(0,1fr)]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-body-sm text-body">{k}</dt>
            <dd className="font-mono text-code break-all text-ink select-all">{v}</dd>
          </div>
        ))}
      </dl>
      {note ? <p className="text-caption text-mute">{note}</p> : null}
    </div>
  );
}
