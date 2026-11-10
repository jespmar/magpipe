import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { asc } from 'drizzle-orm';
import { RunDetailScreen } from '@/components/runs/RunDetailScreen';
import { PageHead } from '@/components/ui/PageHead';
import { UnavailableState } from '@/components/ui/EmptyState';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { listEvents } from '@/lib/engine/events';
import { toFlightEvent, type FlightEvent } from '@/lib/home-util';
import { getRun } from '@/lib/runs';
import { headTitle, type AgentChip } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';

type Props = { params: Promise<{ id: string }> };

type Loaded = { run: Run; events: FlightEvent[]; agents: AgentChip[] };

/** `undefined` = no such flight; `null` = the database is unavailable. */
async function load(displayId: string): Promise<Loaded | null | undefined> {
  try {
    const db = await getDb();
    const run = await getRun(db, displayId);
    if (!run) return undefined;
    const [events, agents] = await Promise.all([
      listEvents(db, run.id, { limit: 200 }),
      db
        .select({
          id: t.agents.id,
          name: t.agents.name,
          initials: t.agents.initials,
          slug: t.agents.slug,
        })
        .from(t.agents)
        .orderBy(asc(t.agents.name)),
    ]);
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return { run, events: events.map((e) => toFlightEvent(e, names)), agents };
  } catch (err) {
    console.error('[runs/[id]] unavailable:', err);
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const loaded = await load(id);
  if (loaded === undefined) return { title: 'Flight not found' };
  return { title: loaded ? `${headTitle(loaded.run.input.text, 60)} · ${id}` : id };
}

/**
 * No `loading.tsx` wraps this route on purpose: a streaming boundary above a page that calls
 * `notFound()` would send a 200 before the 404 is known.
 */
export default async function RunDetailPage({ params }: Props) {
  const { id } = await params;
  const loaded = await load(id);
  if (loaded === undefined) notFound();

  if (loaded === null) {
    return (
      <>
        <PageHead title={id} />
        <UnavailableState />
      </>
    );
  }

  return (
    <RunDetailScreen
      run={loaded.run}
      events={loaded.events}
      agents={loaded.agents}
      now={new Date()}
    />
  );
}
