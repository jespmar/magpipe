import { AgentCard } from '@/components/home/AgentCard';
import { FlightLog } from '@/components/home/FlightLog';
import { OrchestratorCore } from '@/components/home/OrchestratorCore';
import { PromptComposer } from '@/components/home/PromptComposer';
import { ButtonLink } from '@/components/ui/Button';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { getHomeData, type HomeData } from '@/lib/home';

/**
 * Home (spec §3.2): the flock on duty, the nest, the flight log where there is room for it, and
 * the prompt that starts a run. The log component also tails the live run and refreshes this
 * page's server data while events stream in.
 */
export default async function HomePage() {
  let data: HomeData;
  try {
    data = await getHomeData(await getDb());
  } catch (err) {
    console.error('[home] unavailable:', err);
    return (
      <>
        <PageHead title="Birds on the wire" />
        <UnavailableState />
      </>
    );
  }
  const now = new Date();
  const agentNames = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));

  return (
    <div className="flex flex-col gap-12 wide:gap-8">
      <div className="flex flex-col gap-12 wide:grid wide:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] wide:items-stretch wide:gap-x-10">
        <section aria-label="The flock" className="flex min-w-0 flex-col gap-5">
          <PageHead
            title="Birds on the wire"
            actions={
              <ButtonLink href="/agents?new=1" variant="ghost">
                Add a bird
              </ButtonLink>
            }
          />
          {data.agents.length > 0 ? (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.agents.map((card) => (
                <li key={card.id} className="flex min-w-0">
                  <AgentCard card={card} now={now} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="max-w-[31rem] text-body-sm text-body">
              No birds yet. Add one and it appears here, ready for the next task.
            </p>
          )}
        </section>
        <OrchestratorCore stats={data.stats} hasRuns={data.hasRuns} fresh={data.fresh} />
        <FlightLog
          key={data.latest?.run.id ?? 'none'}
          latest={data.latest}
          agentNames={agentNames}
          className="hidden wide:flex"
        />
      </div>
      <PromptComposer />
    </div>
  );
}
