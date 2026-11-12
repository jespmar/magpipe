import { ProjectForm, type ProjectAgent } from '@/components/factory/ProjectForm';
import { ButtonLink } from '@/components/ui/Button';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { modelOptions } from '@/lib/models';
import { getProject, projectView, workspaceDefaults, type ProjectView } from '@/lib/projects';

/**
 * The project editor's page (D46), for a new project (`id` null) or a project's settings. Returns
 * 'missing' for an unknown id, so the route can answer 404.
 */
export async function ProjectEditorPage({ id }: { id: string | null }) {
  let project: ProjectView | null = null;
  let agents: ProjectAgent[];
  let workspace: Awaited<ReturnType<typeof workspaceDefaults>>;
  try {
    const db = await getDb();
    if (id) {
      const row = await getProject(db, id);
      if (!row) return 'missing' as const;
      project = await projectView(db, row);
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
    console.error('[project settings] unavailable:', err);
    return (
      <>
        <PageHead title={id ? 'Project settings' : 'New project'} />
        <UnavailableState />
      </>
    );
  }
  const models = modelOptions([
    ...agents.map((a) => a.model),
    ...Object.values(project?.models ?? {}),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title={project ? `${project.name} settings` : 'New project'}
        description={
          project
            ? 'Its repository, its Linear project and GitHub repository, and how the factory works on it. Saving reads back what it names from Linear and GitHub.'
            : 'A repository the factory builds in, with its own Linear project and GitHub repository. Saving reads both back before anything is stored.'
        }
        meta={project ? <span>{project.id}</span> : undefined}
        actions={
          <ButtonLink
            href={project ? `/factory/${project.id}` : '/factory'}
            size="sm"
            variant="ghost"
          >
            {project ? `Back to ${project.name}` : 'All projects'}
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
