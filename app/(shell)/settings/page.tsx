import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import { PageHead } from '@/components/ui/PageHead';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { DemoDataForm } from '@/components/settings/DemoDataForm';
import { StandingInstructions } from '@/components/settings/StandingInstructions';
import { RunLimitForm } from '@/components/settings/RunLimitForm';
import { SpendCapForm } from '@/components/settings/SpendCapForm';
import { FactoryForm } from '@/components/settings/FactoryForm';
import { LinearForm } from '@/components/settings/LinearForm';
import { FlockForm } from '@/components/settings/FlockForm';
import { ScrollToHash } from '@/components/ui/ScrollToHash';
import { TextBlock } from '@/components/ui/TextBlock';
import { dataDir, getDb } from '@/lib/db';
import { describeModelBackend } from '@/lib/engine/claude-code';
import { ORCHESTRATOR_SYSTEM } from '@/lib/engine/plan';
import { settings as settingsTable } from '@/lib/db/schema';
import { buildSeed } from '@/lib/db/seed-data';
import { env } from '@/lib/env';
import { listMemory } from '@/lib/memory';
import { STANDING_NS } from '@/lib/memory-util';
import { DEFAULT_FACTORY_SCRIPTS } from '@/lib/factory';
import { DEFAULT_FLOCK_SCRIPTS, FLOCK_DECISIONS } from '@/lib/flock';
import { accessMode } from '@/lib/auth-mode';
import { currentUser } from '@/lib/session';
import { formatUsd } from '@/lib/runs-util';
import { getShellData } from '@/lib/shell-data';
import { SHORTCUTS } from '@/lib/shortcuts';
import { getLinearSettings, linearView, type LinearView } from '@/lib/tracker';
import { capReached, capText, spendToday, type SpendToday } from '@/lib/spend';
import type { MemoryEntry, Settings } from '@/lib/schemas';

export const metadata: Metadata = { title: 'Settings' };

/** What the Linear form starts from when the database cannot be read; it is not shown. */
const EMPTY_LINEAR: LinearView = {
  id: 'linear',
  keyHint: null,
  viewer: null,
  team: null,
  label: null,
  states: {},
  pollSeconds: 60,
  paused: false,
  lastCheckAt: null,
  lastCheck: null,
  lastError: null,
  updatedAt: new Date(0),
  hasKey: false,
  ready: false,
};

async function loadSettings(): Promise<Settings | null> {
  try {
    const [row] = await (await getDb()).select().from(settingsTable).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/** Every `decisions` entry, or null when the database cannot be read (the shell says why). */
async function loadStanding(): Promise<MemoryEntry[] | null> {
  try {
    return await listMemory(await getDb(), { ns: STANDING_NS });
  } catch {
    return null;
  }
}

/** Linear access as Settings shows it (no key), or null when the database cannot be read. */
async function loadLinear(): Promise<LinearView | null> {
  try {
    return linearView(await getLinearSettings(await getDb()));
  } catch {
    return null;
  }
}

async function loadSpend(): Promise<SpendToday | null> {
  try {
    return await spendToday(await getDb());
  } catch {
    return null;
  }
}

/** What the cap counts, for the backend in use (D22: Claude Code's dollars are not a bill). */
const SPEND_COUNTS = {
  'claude-code':
    'Counts today’s runs at API prices. Under Claude Code that is an estimate, not a bill.',
  api: 'Counts today’s runs at the API’s list prices.',
  stub: 'Counts today’s runs at API prices. The scripted model has no price, so it adds nothing.',
} as const;

const MODE_LABEL = {
  desktop: 'desktop app, no sign-in',
  open: 'sign-in disabled for development',
  signin: 'signed in with GitHub',
} as const;

/** Workspace facts (spec §3.7); the daily spend cap is the one the operator edits (D32). */
export default async function SettingsPage() {
  const [settings, spend, user, shell, backend, standing, linear] = await Promise.all([
    loadSettings(),
    loadSpend(),
    currentUser(),
    getShellData(),
    describeModelBackend(),
    loadStanding(),
    loadLinear(),
  ]);
  const backendRows: (readonly [string, string])[] =
    backend.backend === 'claude-code'
      ? [
          ['Backend', 'Claude Code on this machine'],
          [
            'Claude Code',
            backend.cli
              ? `${backend.cli.path}${backend.cli.version ? ` · v${backend.cli.version}` : ''}`
              : 'not found',
          ],
        ]
      : backend.backend === 'api'
        ? [['Backend', 'Claude API, with ANTHROPIC_API_KEY from magpipe.env']]
        : [['Backend', 'Scripted model (development only)']];
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
      <PageHead title="Settings" />
      <ScrollToHash />

      <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start wide:max-w-[1600px]">
        {/* Two columns that stack on their own, so no card leaves a hole beside a taller one. */}
        <div className="flex min-w-0 flex-col gap-6">
          <Section id="workspace" title="Workspace">
            <p className="text-body-sm text-body">
              Read-only for now. Editing these lands with the screens that need them.
            </p>
            <Facts
              title="Identity"
              rows={[
                ['Name', settings?.workspaceName ?? dash],
                ['Region label', env.MAGPIPE_REGION ?? settings?.region ?? dash],
              ]}
            />
            <Facts
              title="Models"
              rows={[
                ['Orchestrator', settings?.models.orchestrator ?? dash],
                ['Default for new agents', settings?.models.default ?? dash],
                ...backendRows,
              ]}
              note={
                backend.problem ??
                'Runs go through the Claude Code on this machine unless magpipe.env sets MAGPIPE_MODEL_BACKEND=api with a key.'
              }
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
                <Button type="submit" variant="secondary" size="sm">
                  Sign out
                </Button>
              </form>
            ) : null}
          </Section>
          <Section id="factory" title="Software factory">
            <p className="max-w-[31rem] text-body-sm text-body">
              Nine birds that turn an idea into a reviewed change, each stage run from a template
              rather than a plan. Send to the factory on Home has the Spec Builder write a spec and
              the Spec Review check it. With Linear set up, an approved spec is split into goals,
              and each goal is built on its own branch, tests first, until it is ready to merge.
            </p>
            <FactoryForm
              defaultScripts={DEFAULT_FACTORY_SCRIPTS}
              disabledReason={
                shell.dbError
                  ? 'Needs the database. See the notice at the top of the page.'
                  : undefined
              }
            />
          </Section>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Section id="spend" title="Spend cap">
            <p className="text-body-sm text-body">
              Once today’s spend reaches the cap, runs stop before their next step. Steps already
              working finish.
            </p>
            <Facts
              rows={[
                [
                  'Spent today',
                  spend
                    ? `${formatUsd(spend.spentUsd)} ${spend.capUsd ? 'of' : '·'} ${capText(spend.capUsd)}`
                    : dash,
                ],
              ]}
            />
            {spend && capReached(spend) ? (
              <p className="text-body-sm text-warn">
                Today’s spend has reached the cap. Raise it to start runs again today.
              </p>
            ) : null}
            <SpendCapForm
              capUsd={settings?.spendCapUsd ?? 0}
              disabledReason={
                settings ? undefined : 'Needs the database. See the notice at the top of the page.'
              }
            />
            <p className="text-caption text-mute">{SPEND_COUNTS[backend.backend]}</p>
            <RunLimitForm
              maxRuns={settings?.maxRuns ?? 2}
              disabledReason={
                settings ? undefined : 'Needs the database. See the notice at the top of the page.'
              }
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
                  ? 'Needs the database. See the notice at the top of the page.'
                  : undefined
              }
            />
          </Section>
          <Section id="flock" title="Development flock">
            <p className="text-body-sm text-body">
              Five birds for software work on one repository: Researcher reads, Planner writes a
              plan file, Coder commits on a branch, Verifier runs the checks and Reviewer reads the
              diff. None of them pushes or merges; that stays with you. Loading it again puts them
              back as written.
            </p>
            <FlockForm
              defaultScripts={DEFAULT_FLOCK_SCRIPTS}
              decisions={FLOCK_DECISIONS.length}
              disabledReason={
                shell.dbError
                  ? 'Needs the database. See the notice at the top of the page.'
                  : undefined
              }
            />
          </Section>
        </div>
        <Section id="linear" title="Linear" className="md:col-span-2">
          <p className="max-w-[31rem] text-body-sm text-body">
            Where the factory keeps its record. A spec that passes review is filed as an issue with
            the label, and you approve it there or from the spec&rsquo;s flight. Without Linear,
            specs stay in Magpipe.
          </p>
          {linear ? (
            <LinearForm initial={linear} />
          ) : (
            <LinearForm
              initial={EMPTY_LINEAR}
              disabledReason="Needs the database. See the notice at the top of the page."
            />
          )}
        </Section>
        <Section id="orchestrator" title="Orchestrator" className="md:col-span-2">
          <p className="max-w-[31rem] text-body-sm text-body">
            Every run starts with a plan. The orchestrator writes it from these rules, the agents
            and their tools, and the memory that matters to the task. The rules come with Magpipe;
            the standing instructions are yours.
          </p>
          <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
            <TextBlock
              title="Orchestrator rules"
              text={ORCHESTRATOR_SYSTEM}
              copyLabel="Copy rules"
              maxHeight={480}
            />
            <StandingInstructions entries={standing} />
          </div>
        </Section>

        <Section id="keyboard" title="Keyboard" className="md:col-span-2">
          <p className="text-body-sm text-body">
            Single keys work anywhere outside a text field; press <Kbd>?</Kbd> on any screen to see
            this list.
          </p>
          {/* Single keys and the `g then …` chords as two groups, keys in a fixed left column. */}
          <div className="grid gap-6 md:grid-cols-2 md:gap-x-10">
            {[
              { title: 'Keys', items: SHORTCUTS.filter((s) => !s.chord) },
              { title: 'Go to a screen', items: SHORTCUTS.filter((s) => s.chord) },
            ].map((group) => (
              <div key={group.title} className="flex flex-col gap-3">
                <h3 className="text-body-sm font-medium text-ink">{group.title}</h3>
                <dl className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
                  {group.items.map((s) => (
                    <div key={s.label} className="contents">
                      <dt className="flex items-center gap-1 font-mono text-code text-ink">
                        {s.keys.map((k, i) => (
                          <span key={k} className="inline-flex items-center gap-1">
                            {i > 0 ? (
                              <span className="text-mute">{s.chord ? 'then' : '+'}</span>
                            ) : null}
                            <Kbd>{k}</Kbd>
                          </span>
                        ))}
                      </dt>
                      <dd className="self-center text-body-sm text-body">{s.label}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
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
      className={`flex scroll-mt-24 flex-col gap-4 card p-5 ${className ?? ''}`}
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
  title?: string;
  rows: ReadonlyArray<readonly [string, string]>;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      {title ? <h3 className="text-body-sm font-medium text-ink">{title}</h3> : null}
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
