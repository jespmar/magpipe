import type { Metadata } from 'next';
import { asc } from 'drizzle-orm';
import { RunsScreen } from '@/components/runs/RunsScreen';
import { PageHead } from '@/components/ui/PageHead';
import { UnavailableState } from '@/components/ui/EmptyState';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { listRuns, runsStats } from '@/lib/runs';

export const metadata: Metadata = { title: 'Runs' };

type Props = { searchParams: Promise<{ run?: string }> };

/** The Runs screen (spec §3.4): the hundred most recent flights, the day's numbers, the selection. */
export default async function RunsPage({ searchParams }: Props) {
  const params = await searchParams;
  try {
    const db = await getDb();
    const [{ runs, counts }, agents, stats, toolCount, memoryCount] = await Promise.all([
      listRuns(db, { limit: 100 }),
      db
        .select({
          id: t.agents.id,
          name: t.agents.name,
          initials: t.agents.initials,
          slug: t.agents.slug,
        })
        .from(t.agents)
        .orderBy(asc(t.agents.name)),
      runsStats(db),
      db.$count(t.tools),
      db.$count(t.memory),
    ]);
    return (
      <RunsScreen
        runs={runs}
        counts={counts}
        agents={agents}
        stats={stats}
        fresh={counts.all === 0 && toolCount === 0 && memoryCount === 0}
        initialId={params.run}
        now={new Date()}
      />
    );
  } catch (err) {
    console.error('[runs] unavailable:', err);
    return (
      <>
        <PageHead
          title="Runs"
          description="Every task Magpipe has sent the flock out on: who flew, how long it took, what it cost."
        />
        <UnavailableState />
      </>
    );
  }
}
