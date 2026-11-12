import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/factory/AutoRefresh';
import { FactoryBoard } from '@/components/factory/FactoryBoard';
import { SpecComposer } from '@/components/factory/SpecComposer';
import { ButtonLink } from '@/components/ui/Button';
import { UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { StatusPill } from '@/components/ui/StatusPill';
import { getDb } from '@/lib/db';
import { missingAgents } from '@/lib/factory';
import { getBoard, type Board } from '@/lib/factory-board';
import { clockTime } from '@/lib/home-util';
import {
  getProject,
  projectRuns,
  projectView,
  type ProjectGap,
  type ProjectView,
} from '@/lib/projects';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/** What a project still needs, and where to give it (D46). */
const GAPS: Record<ProjectGap, { text: string; href: string }> = {
  linear_key: { text: 'No Linear key: save one in Settings or on this project.', href: 'settings' },
  linear_project: {
    text: 'No Linear project yet: specs are written and reviewed, but not filed or watched.',
    href: 'settings',
  },
  github_token: {
    text: 'No GitHub token: goals stop at a branch to merge by hand.',
    href: 'settings',
  },
  github_repo: { text: 'No GitHub repository yet: goals stop at a branch.', href: 'settings' },
};

const TEMPLATE_NAMES: Record<string, string> = {
  spec: 'Spec',
  goals: 'Goals',
  build: 'Build',
  land: 'Land',
};

/**
 * One factory project (D46): its own Specification Agent, its factory board and its runs, with
 * what it still needs before the factory runs end to end. No loading boundary: an unknown id is
 * a 404.
 */
export default async function ProjectPage({ params }: Props) {
  const { id } = await params;
  let project: ProjectView | undefined;
  let board: Board;
  let runs: Awaited<ReturnType<typeof projectRuns>>;
  let loaded = false;
  try {
    const db = await getDb();
    const row = await getProject(db, id);
    if (row) {
      project = await projectView(db, row);
      [board, runs, loaded] = await Promise.all([
        getBoard(db, { projectId: row.id }),
        projectRuns(db, row.id),
        missingAgents(db, 'spec').then((m) => m.length === 0),
      ]);
    }
  } catch (err) {
    console.error('[project] unavailable:', err);
    return (
      <>
        <PageHead title="Project" />
        <UnavailableState />
      </>
    );
  }
  if (!project) notFound();

  const where = [
    project.linear.project && project.linearReady
      ? `files into ${project.linear.project.name}`
      : 'no Linear project',
    project.github.repo ? `lands in ${project.github.repo}` : 'no repository',
    board!.lastCheckAt ? `last check ${clockTime(board!.lastCheckAt)}` : 'not checked yet',
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHead
        title={project.name}
        description={
          project.context ||
          'Its specs, goals and pull requests. Add a brief for the agents in Settings.'
        }
        meta={where.map((m) => (
          <span key={m}>{m}</span>
        ))}
        actions={
          <>
            <ButtonLink href="/factory" size="sm" variant="ghost">
              All projects
            </ButtonLink>
            <ButtonLink href={`/factory/${project.id}/settings`} size="sm">
              Settings
            </ButtonLink>
          </>
        }
      />

      {project.gaps.length > 0 ? (
        <section aria-label="What this project needs" className="flex flex-col gap-2 card p-5">
          <h2 className="font-medium text-body text-ink">Before the factory runs end to end</h2>
          <ul className="flex flex-col gap-1">
            {project.gaps.map((g) => (
              <li key={g} className="text-amber text-body-sm">
                {GAPS[g].text}{' '}
                <Link
                  href={`/factory/${project.id}/${GAPS[g].href}`}
                  className="text-ink underline underline-offset-2"
                >
                  Set it up
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="spec-heading" className="flex flex-col gap-4 card p-6">
        <h2 id="spec-heading" className="font-medium text-body text-ink">
          Specification
        </h2>
        {loaded ? (
          <SpecComposer
            projectId={project.id}
            projectName={project.name}
            linearReady={project.linearReady}
          />
        ) : (
          <p className="max-w-[31rem] text-body-sm text-body">
            The factory&rsquo;s agents are not loaded or some are paused. Load them in{' '}
            <Link href="/settings#factory" className="text-ink underline underline-offset-2">
              Settings
            </Link>{' '}
            or resume them on Agents to write specs here.
          </p>
        )}
      </section>

      <section aria-labelledby="board-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="board-heading" className="font-medium text-body text-ink">
            Factory
          </h2>
          <p className="font-mono text-code text-mute">
            {board!.counts.specs} {board!.counts.specs === 1 ? 'spec' : 'specs'} ·{' '}
            {board!.counts.goals} {board!.counts.goals === 1 ? 'goal' : 'goals'} ·{' '}
            {board!.counts.building} building · {board!.counts.landing} merging
          </p>
        </div>
        {board!.lastError ? (
          <p role="status" className="text-body-sm text-danger">
            The last check said: {board!.lastError}
          </p>
        ) : null}
        {board!.counts.specs + board!.counts.goals > 0 ? (
          <FactoryBoard board={board!} />
        ) : (
          <p className="max-w-[31rem] text-body-sm text-body">
            Nothing in the factory yet. A spec that passes review lands here waiting for your
            approval, then its goals build and wait for your answer to merge.
          </p>
        )}
      </section>

      <section aria-labelledby="runs-heading" className="flex flex-col gap-4">
        <h2 id="runs-heading" className="font-medium text-body text-ink">
          Runs
        </h2>
        {runs!.length > 0 ? (
          <ul className="divide-y divide-hairline card">
            {runs!.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <Link
                  href={`/runs/${r.displayId}`}
                  className="font-mono text-code text-ink hover:text-cyan focus-visible:text-cyan"
                >
                  {r.displayId}
                </Link>
                <span className="w-14 text-caption text-mute">
                  {TEMPLATE_NAMES[r.input.template ?? ''] ?? 'Run'}
                </span>
                <span className="min-w-0 flex-1 truncate text-body-sm text-body">
                  {r.input.text}
                </span>
                <StatusPill variant={r.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-mute">No runs for this project yet.</p>
        )}
      </section>
      <AutoRefresh />
    </div>
  );
}
