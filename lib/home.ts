import 'server-only';
import { asc } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { listEvents } from './engine/events';
import { agentCard, toFlightEvent, type AgentCardData, type FlightEvent } from './home-util';
import { homeStats, listRuns, type HomeStats } from './runs';
import type { RunStatus } from './schemas';

export type LatestFlight = {
  run: { id: string; displayId: string; title: string; status: RunStatus };
  events: FlightEvent[];
};

export type HomeData = {
  agents: AgentCardData[];
  stats: HomeStats;
  /** The run in progress, or the most recent one; null before the first run. */
  latest: LatestFlight | null;
  hasRuns: boolean;
  /** A workspace with nothing but the starter agents — the demo data is the obvious next step. */
  fresh: boolean;
};

/** Everything the Home screen shows, in one read (spec §3.2). Throws when the database is down. */
export async function getHomeData(db: Db): Promise<HomeData> {
  const [agents, { runs, counts }, stats, toolCount, memoryCount] = await Promise.all([
    db.select().from(t.agents).orderBy(asc(t.agents.name)),
    listRuns(db, { limit: 50 }),
    homeStats(db),
    db.$count(t.tools),
    db.$count(t.memory),
  ]);
  const latestRun =
    runs.find((r) => r.status === 'running' || r.status === 'queued') ?? runs[0] ?? null;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const events = latestRun ? await listEvents(db, latestRun.id, { limit: 60 }) : [];
  return {
    agents: agents.map((a) => agentCard(a, runs)),
    stats,
    latest: latestRun
      ? {
          run: {
            id: latestRun.id,
            displayId: latestRun.displayId,
            title: latestRun.input.text,
            status: latestRun.status,
          },
          events: events.map((e) => toFlightEvent(e, names)),
        }
      : null,
    hasRuns: counts.all > 0,
    fresh: counts.all === 0 && toolCount === 0 && memoryCount === 0,
  };
}
