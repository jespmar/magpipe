import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProjectForm, type ProjectAgent } from '@/components/factory/ProjectForm';
import { ButtonLink } from '@/components/ui/Button';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { modelOptions } from '@/lib/models';
import { getProject, projectView, workspaceDefaults, type ProjectView } from '@/lib/projects';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/**
 * One factory project (D45), or a new one at `/factory/projects/new`. No loading boundary of its
 * own: an unknown id is a 404.
 */
export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  let project: ProjectView | null = null;
  let agents: ProjectAgent[];
  let workspace: Awaited<ReturnType<typeof workspaceDefaults>>;
  let missing = false;
  try {
    const db = await getDb();
    if (id !== 'new') {
      const row = await getProject(db, id);
      if (row) project = await projectView(db, row);
      else missing = true;
    }
    const rows = await db
      .select({
        slug: t.agents.slug,
        name: t.agents.name,
        model: t.agents.model,
        templateOnly: t.agents.templateOnly,
      })
      .from(t.agents);
    agents = rows
      .filter((a) => a.templateOnly)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ slug, name, model }) => ({ slug, name, model }));
    workspace = await workspaceDefaults(db);
  } catch (err) {
    console.error('[project] unavailable:', err);
    return (
      <>
        <PageHead title="Project" />
        <UnavailableState />
      </>
    );
  }
  if (missing) notFound();
  const models = modelOptions([
    ...agents.map((a) => a.model),
    ...Object.values(project?.models ?? {}),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title={project?.name ?? 'New project'}
        description={
          project
            ? 'Its repository, where its work is tracked and lands, and how the factory works on it. Saving reads back what it names from Linear and GitHub.'
            : 'A repository the factory builds in, with its own Linear and GitHub or the workspace’s. Saving reads back what it names before anything is stored.'
        }
        meta={project ? <span>{project.id}</span> : undefined}
        actions={
          <ButtonLink href="/factory/projects" size="sm" variant="ghost">
            All projects
          </ButtonLink>
        }
      />
      <ProjectForm
        key={project?.id ?? 'new'}
        initial={project}
        agents={agents}
        models={models}
        workspace={workspace}
      />
    </div>
  );
}
