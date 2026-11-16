import { HomeScreen } from '@/components/home/HomeScreen';
import { OrchestratorCore } from '@/components/home/OrchestratorCore';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { missingAgents } from '@/lib/factory';
import { getHomeData, type HomeData } from '@/lib/home';
import { ensureDefaultProject, listProjects } from '@/lib/projects';

/**
 * Home (spec §3.2, D21, D23): the nest in the middle, the latest flights as small cards beside
 * it, the selected flight on the other side, and the prompt at the bottom of the screen, always
 * within reach. The roster is the Agents screen. Once the software factory is installed and has a
 * project, the prompt can send a task to its spec template (D37, D50).
 */
export default async function HomePage() {
  let data: HomeData;
  let factory = false;
  let projects: { id: string; name: string }[] = [];
  try {
    const db = await getDb();
    data = await getHomeData(db);
    // The factory needs its agents and a project to file into (D50).
    if ((await missingAgents(db, 'spec')).length === 0) {
      await ensureDefaultProject(db);
      projects = (await listProjects(db)).map((p) => ({ id: p.id, name: p.name }));
      factory = projects.length > 0;
    }
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
      projects={projects}
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
