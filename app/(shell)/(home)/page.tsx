import { AgentCard } from '@/components/home/AgentCard';
import { FlightLog } from '@/components/home/FlightLog';
import { OrchestratorCore } from '@/components/home/OrchestratorCore';
import { PromptComposer } from '@/components/home/PromptComposer';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { getHomeData, type HomeData } from '@/lib/home';
import { LIVE_RUN_STATUSES } from '@/lib/home-util';

/**
 * Home (spec §3.2, D21): what is happening now. At rest it is the nest and the prompt, nothing
 * else. While a flight is live it also shows the birds that are flying and the live trail; the
 * roster lives on Agents and finished trails on Runs.
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
  const flying = data.agents.filter((a) => a.live);
  const busy = liveRun !== null || flying.length > 0;
  const agentNames = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));

  if (!busy) {
    return (
      <div className="flex flex-col gap-10 py-4">
        <OrchestratorCore stats={data.stats} hasRuns={data.hasRuns} fresh={data.fresh} />
        <PromptComposer />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 wide:gap-8">
      <div className="flex flex-col gap-10 wide:grid wide:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] wide:items-stretch wide:gap-x-10">
        <section aria-labelledby="flying-title" className="flex min-w-0 flex-col gap-4">
          <h2 id="flying-title" className="page-title">
            Flying now
          </h2>
          {flying.length > 0 ? (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {flying.map((card) => (
                <li key={card.id} className="flex min-w-0">
                  <AgentCard card={card} now={now} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="max-w-[31rem] text-body-sm text-body">
              Magpipe is drawing up the plan. The birds it picks appear here as they take off.
            </p>
          )}
        </section>
        <OrchestratorCore
          stats={data.stats}
          hasRuns={data.hasRuns}
          fresh={data.fresh}
          className="wide:border-x wide:border-hairline-soft"
        />
        <FlightLog key={liveRun?.run.id ?? 'none'} latest={liveRun} agentNames={agentNames} />
      </div>
      <PromptComposer />
    </div>
  );
}
