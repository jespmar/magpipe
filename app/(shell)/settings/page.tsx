import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { signOut } from '@/auth';
import { PageHead } from '@/components/ui/PageHead';
import { Button } from '@/components/ui/Button';
import { dataDir, getDb } from '@/lib/db';
import { settings as settingsTable } from '@/lib/db/schema';
import { loadDemo } from '@/lib/db/seed';
import { env } from '@/lib/env';
import { accessMode } from '@/lib/auth-mode';
import { currentUser } from '@/lib/session';
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

async function loadDemoAction() {
  'use server';
  await loadDemo(await getDb());
  revalidatePath('/', 'layout');
}

const MODE_LABEL = {
  desktop: 'Desktop app · no sign-in',
  open: 'Sign-in disabled (development)',
  signin: 'Signed in with GitHub',
} as const;

/** Read-only for now (spec §3.7) — editing lands with the screen that first needs it. */
export default async function SettingsPage() {
  const [settings, user] = await Promise.all([loadSettings(), currentUser()]);
  const mode = accessMode();

  const rows: [string, string][] = [
    ['Workspace', settings?.workspaceName ?? '—'],
    ['Region label', env.MAGPIPE_REGION ?? settings?.region ?? '—'],
    ['Spend cap / day', settings ? `$${settings.spendCapUsd.toFixed(2)}` : '—'],
    ['Orchestrator model', settings?.models.orchestrator ?? '—'],
    ['Default agent model', settings?.models.default ?? '—'],
    ['Data folder', dataDir()],
  ];
  if (env.MAGPIPE_CONFIG_PATH) rows.push(['Config file', env.MAGPIPE_CONFIG_PATH]);

  return (
    <>
      <PageHead eyebrow="Workspace" title="Settings" />
      <section className="max-w-3xl rounded-md border border-hairline bg-(image:--g-card) p-6">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-[200px_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="self-center label-caps">{k}</dt>
              <dd className="font-mono text-code break-all text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex max-w-3xl flex-wrap items-center justify-between gap-4 rounded-md border border-hairline bg-(image:--g-card) p-6">
        <div className="flex max-w-lg flex-col gap-0.5">
          <span className="label-caps">Demo data</span>
          <span className="text-body-sm text-body">
            Adds the design&apos;s tools, memory and finished runs, and grants the agents their
            tools. Running it again refreshes the demo rows and leaves your own data alone.
          </span>
        </div>
        <form action={loadDemoAction}>
          <Button type="submit" variant="outline">
            Load demo data
          </Button>
        </form>
      </section>

      <section className="flex max-w-3xl flex-wrap items-center justify-between gap-4 rounded-md border border-hairline bg-(image:--g-card) p-6">
        <div className="flex flex-col gap-0.5">
          <span className="label-caps">Access</span>
          <span className="text-body-md text-ink-strong">
            {user?.name ?? user?.email ?? 'Unknown'}
            <span className="text-mute"> · {MODE_LABEL[mode]}</span>
          </span>
        </div>
        {mode === 'signin' ? (
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        ) : null}
      </section>
    </>
  );
}
