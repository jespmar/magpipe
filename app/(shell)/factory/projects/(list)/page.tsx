import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderGit2 } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import {
  ensureDefaultProject,
  listProjects,
  projectCounts,
  projectView,
  type ProjectView,
} from '@/lib/projects';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'Each project is a repository and where its work is tracked and lands. A spec from Home goes to the project you pick, and its goals build there.';

/** Factory → Projects (D45): every project with what it uses, and a way to add one. */
export default async function ProjectsPage() {
  let projects: ProjectView[];
  let counts: Map<string, { specs: number; goals: number }>;
  try {
    const db = await getDb();
    await ensureDefaultProject(db);
    const rows = await listProjects(db);
    projects = await Promise.all(rows.map((p) => projectView(db, p)));
    counts = await projectCounts(db);
  } catch (err) {
    console.error('[projects] unavailable:', err);
    return (
      <>
        <PageHead title="Projects" />
        <UnavailableState />
      </>
    );
  }

  const head = (
    <PageHead
      title="Projects"
      description={DESCRIPTION}
      meta={<span>{projects.length === 1 ? 'one project' : `${projects.length} projects`}</span>}
      actions={
        <>
          <ButtonLink href="/factory" size="sm" variant="ghost">
            Back to the factory
          </ButtonLink>
          <ButtonLink href="/factory/projects/new" size="sm" variant="primary">
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
          label="Projects"
          title="No projects yet"
          description="Load the software factory in Settings onto a repository and it becomes the Default project, or add a project here with its folder, Linear and GitHub."
          facts={['no projects']}
          actions={
            <ButtonLink href="/settings#factory" size="sm">
              Load the factory
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
          const c = counts.get(p.id) ?? { specs: 0, goals: 0 };
          const linear = p.effectiveLinear.team
            ? `${p.effectiveLinear.team.name}${p.linear.project ? `, ${p.linear.project.name}` : ''}${p.effectiveLinear.own ? '' : ' (workspace)'}`
            : 'Linear not set up';
          const github = p.effectiveGithub.repo
            ? `${p.effectiveGithub.repo}${p.effectiveGithub.own ? '' : ' (workspace)'}`
            : 'GitHub not set up';
          return (
            <li key={p.id} className="flex flex-col gap-3 card p-5">
              <Link
                href={`/factory/projects/${p.id}`}
                className="font-medium text-body text-ink hover:text-cyan focus-visible:text-cyan"
              >
                {p.name}
              </Link>
              <p className="truncate font-mono text-code text-mute" title={p.repoPath}>
                {p.repoPath}
              </p>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
                <dt className="text-mute">Linear</dt>
                <dd className={p.linearReady ? 'text-ink' : 'text-amber'}>{linear}</dd>
                <dt className="text-mute">GitHub</dt>
                <dd className={p.githubReady ? 'text-ink' : 'text-mute'}>{github}</dd>
                <dt className="text-mute">Work</dt>
                <dd className="font-mono text-code text-ink">
                  {c.specs} {c.specs === 1 ? 'spec' : 'specs'}, {c.goals}{' '}
                  {c.goals === 1 ? 'goal' : 'goals'}
                </dd>
                <dt className="text-mute">Limits</dt>
                <dd className="font-mono text-code text-ink">
                  {p.maxRuns ? `${p.maxRuns} at once` : 'workspace’s'}
                  {p.spendCapUsd ? `, $${p.spendCapUsd.toFixed(2)} a day` : ''}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
