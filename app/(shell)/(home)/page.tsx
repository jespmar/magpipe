import { HomeScreen } from '@/components/home/HomeScreen';
import { OrchestratorCore } from '@/components/home/OrchestratorCore';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { missingAgents } from '@/lib/factory';
import { getHomeData, type HomeData } from '@/lib/home';

/**
 * Home (spec §3.2, D21, D23): the nest in the middle, the latest flights as small cards beside
 * it, the selected flight on the other side, and the prompt at the bottom of the screen, always
 * within reach. The roster is the Agents screen. Once the software factory is loaded, the prompt
 * can send a task to its spec template (D37).
 */
export default async function HomePage() {
  let data: HomeData;
  let factory = false;
  try {
    const db = await getDb();
    data = await getHomeData(db);
    factory = (await missingAgents(db, 'spec')).length === 0;
  } catch (err) {
    console.error('[home] unavailable:', err);
    return (
      <>
        <PageHead title="The nest" />
        <UnavailableState />
      </>
    );
  }
  const agentNames = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));

  return (
    <HomeScreen
      runs={data.recent}
      agentNames={agentNames}
      initialSelectedId={data.selectedId}
      initialEvents={data.selectedEvents}
      now={new Date()}
      factory={factory}
      core={
        <OrchestratorCore
          stats={data.stats}
          hasRuns={data.hasRuns}
          fresh={data.fresh}
          className="min-w-0 flex-1"
        />
      }
    />
  );
}
