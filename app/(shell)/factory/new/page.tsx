import type { Metadata } from 'next';
import { ProjectWizard } from '@/components/factory/ProjectWizard';
import { ButtonLink } from '@/components/ui/Button';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { factoryInstalled } from '@/lib/factory';
import { listProjects, workspaceDefaults } from '@/lib/projects';
import { wizardParentFolder } from '@/lib/project-wizard';

export const metadata: Metadata = { title: 'New project' };
export const dynamic = 'force-dynamic';

/**
 * A new factory project (D49), step by step: its GitHub repository, picked or made; the folder it
 * is cloned into; its Linear project, picked or made; its name, scripts and brief.
 */
export default async function NewProjectPage() {
  const head = (
    <PageHead
      title="New project"
      description="A repository the factory builds in, with its own GitHub repository and Linear project. Nothing is made on GitHub, in Linear or on this computer until the last step."
      actions={
        <ButtonLink href="/factory" size="sm" variant="ghost">
          All projects
        </ButtonLink>
      }
    />
  );
  let props: Parameters<typeof ProjectWizard>[0];
  try {
    const db = await getDb();
    const [projects, workspace, parentFolder, installed] = await Promise.all([
      listProjects(db),
      workspaceDefaults(db),
      wizardParentFolder(db),
      factoryInstalled(db),
    ]);
    props = {
      parentFolder,
      factoryInstalled: installed,
      hasGithubKey: workspace.hasGithubKey,
      hasLinearKey: workspace.hasLinearKey,
      takenRepos: Object.fromEntries(
        projects.filter((p) => p.github.repo).map((p) => [p.github.repo!.toLowerCase(), p.name]),
      ),
      takenLinear: Object.fromEntries(
        projects.filter((p) => p.linear.project).map((p) => [p.linear.project!.id, p.name]),
      ),
    };
  } catch (err) {
    console.error('[new project] unavailable:', err);
    return (
      <>
        {head}
        <UnavailableState />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {head}
      <ProjectWizard {...props} />
    </div>
  );
}
