import { FlightLog } from '@/components/home/FlightLog';
import { RunMiniCards } from '@/components/home/HomeCards';
import { OrchestratorCore } from '@/components/home/OrchestratorCore';
import { PromptComposer } from '@/components/home/PromptComposer';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { getHomeData, type HomeData } from '@/lib/home';
import { LIVE_RUN_STATUSES } from '@/lib/home-util';

/**
 * Home (spec §3.2, D21): the nest in the middle, the latest flights as small cards beside it,
 * the live trail on the other side while a flight is running, and the prompt at the bottom of
 * the screen, always within reach. The roster is the Agents screen.
 */
export default async function HomePage() {
  let data: HomeData;
  try {
    data = await getHomeData(await getDb());
  } catch (err) {
    console.error('[home] unavailable:', err);
    return (
      <>
        <PageHead title="The nest" />
        <UnavailableState />
      </>
    );
  }
  const now = new Date();
  const liveRun = data.latest && LIVE_RUN_STATUSES.has(data.latest.run.status) ? data.latest : null;
  const agentNames = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-10">
      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:items-start md:gap-x-8 wide:gap-x-12">
        <RunMiniCards runs={data.recent} now={now} className="order-2 md:order-1" />
        <OrchestratorCore
          stats={data.stats}
          hasRuns={data.hasRuns}
          fresh={data.fresh}
          className="order-1 md:order-2"
        />
        {liveRun ? (
          <FlightLog
            key={liveRun.run.id}
            latest={liveRun}
            agentNames={agentNames}
            className="order-3 flex"
          />
        ) : (
          <div aria-hidden className="hidden md:order-3 md:block" />
        )}
      </div>
      {/* Pinned to the bottom of the screen: the one thing Home is for stays within reach. */}
      <div className="z-10 mt-auto bg-canvas pt-4 pb-2 md:sticky md:bottom-0">
        <PromptComposer />
      </div>
    </div>
  );
}
