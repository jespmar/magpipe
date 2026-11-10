import 'server-only';
import { asc } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { listEvents } from './engine/events';
import {
  agentCard,
  defaultSelected,
  toFlightEvent,
  type AgentCardData,
  type FlightEvent,
} from './home-util';
import { homeStats, listRuns, type HomeStats } from './runs';
import type { Run } from './schemas';

/** How many cards Home shows; closing one lets an older flight back in. */
const CARD_COUNT = 8;

export type HomeData = {
  agents: AgentCardData[];
  /** The newest flights first, their cards not closed. */
  recent: Run[];
  stats: HomeStats;
  /** The run Home opens on: the live one, else the newest; null before the first run. */
  selectedId: string | null;
  /** That run's trail so far; the panel streams the rest. */
  selectedEvents: FlightEvent[];
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
  const recent = runs.filter((r) => r.dismissedAt === null).slice(0, CARD_COUNT);
  const selected = defaultSelected(recent);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const events = selected ? await listEvents(db, selected.id, { afterSeq: 0, limit: 200 }) : [];
  return {
    agents: agents.map((a) => agentCard(a, runs)),
    recent,
    stats,
    selectedId: selected?.id ?? null,
    selectedEvents: events.map((e) => toFlightEvent(e, names)),
    hasRuns: counts.all > 0,
    fresh: counts.all === 0 && toolCount === 0 && memoryCount === 0,
  };
}
