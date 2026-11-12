import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderGit2 } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { missingAgents } from '@/lib/factory';
import { getLinearSettings } from '@/lib/tracker';
import { clockTime } from '@/lib/home-util';
import {
  ensureDefaultProject,
  listProjects,
  projectCounts,
  projectView,
  type ProjectCounts,
  type ProjectView,
} from '@/lib/projects';

export const metadata: Metadata = { title: 'Factory' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Each project is a repository with its own Linear project and GitHub repository. Write a spec in a project and the factory files it, splits it into goals and builds them there.';

const NONE: ProjectCounts = { specs: 0, goals: 0, waiting: 0, open: 0 };

/** Factory (D46): the projects, each with its own spec box, board and runs on its page. */
export default async function FactoryPage() {
  let projects: ProjectView[];
  let counts: Map<string, ProjectCounts>;
  let loaded = false;
  let lastCheckAt: Date | null = null;
  try {
    const db = await getDb();
    await ensureDefaultProject(db);
    const rows = await listProjects(db);
    [projects, counts, loaded, lastCheckAt] = await Promise.all([
      Promise.all(rows.map((p) => projectView(db, p))),
      projectCounts(db),
      missingAgents(db, 'spec').then((m) => m.length === 0),
      getLinearSettings(db).then((s) => s.lastCheckAt),
    ]);
  } catch (err) {
    console.error('[factory] unavailable:', err);
    return (
      <>
        <PageHead title="Factory" />
        <UnavailableState />
      </>
    );
  }

  const waiting = projects.reduce((n, p) => n + (counts.get(p.id) ?? NONE).waiting, 0);
  const head = (
    <PageHead
      title="Factory"
      description={DESCRIPTION}
      meta={[
        projects.length === 1 ? 'one project' : `${projects.length} projects`,
        waiting === 1 ? 'one thing waits for you' : `${waiting} things wait for you`,
        lastCheckAt ? `last check ${clockTime(lastCheckAt)}` : 'not checked yet',
      ].map((m) => (
        <span key={m}>{m}</span>
      ))}
      actions={
        <>
          <ButtonLink href="/settings#linear" size="sm" variant="ghost">
            Keys and watcher
          </ButtonLink>
          <ButtonLink href="/factory/new" size="sm" variant="primary">
            New project
          </ButtonLink>
        </>
      }
    />
  );

  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        {head}
        <EmptyState
          icon={<FolderGit2 size={24} strokeWidth={1.75} />}
          label="Factory"
          title="No projects yet"
          description="A project is a repository with its own Linear project and GitHub repository. Load the factory's agents in Settings, then add a project here; specs you write in it are filed in its Linear project and built in its repository."
          facts={[loaded ? 'factory agents loaded' : 'factory agents not loaded', 'no projects']}
          actions={
            <ButtonLink href={loaded ? '/factory/new' : '/settings#factory'} size="sm">
              {loaded ? 'Add a project' : 'Load the factory'}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {head}
      <ul className="grid gap-4 md:grid-cols-2 wide:grid-cols-3">
        {projects.map((p) => {
          const c = counts.get(p.id) ?? NONE;
          return (
            <li key={p.id} className="flex flex-col gap-3 card p-5">
              <Link
                href={`/factory/${p.id}`}
                className="font-medium text-body text-ink hover:text-cyan focus-visible:text-cyan"
              >
                {p.name}
              </Link>
              <p className="truncate font-mono text-code text-mute" title={p.repoPath}>
                {p.repoPath}
              </p>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
                <dt className="text-mute">Linear</dt>
                <dd className={p.linearReady ? 'text-ink' : 'text-amber'}>
                  {p.linearReady && p.linear.project
                    ? `${p.linear.project.name} (${p.linear.team?.key ?? ''})`
                    : 'needs its Linear project'}
                </dd>
                <dt className="text-mute">GitHub</dt>
                <dd className={p.github.repo ? 'text-ink' : 'text-amber'}>
                  {p.github.repo ?? 'needs its repository'}
                </dd>
                <dt className="text-mute">Work</dt>
                <dd className="font-mono text-code text-ink">
                  {c.specs} {c.specs === 1 ? 'spec' : 'specs'}, {c.goals}{' '}
                  {c.goals === 1 ? 'goal' : 'goals'}, {c.open} open
                </dd>
                <dt className="text-mute">Waiting</dt>
                <dd
                  className={
                    c.waiting ? 'text-amber font-mono text-code' : 'font-mono text-code text-mute'
                  }
                >
                  {c.waiting ? `${c.waiting} for you` : 'nothing for you'}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
