/**
 * Gives the factory's Default project its own Linear project and GitHub side (D46), the way the
 * project editor would after reading them back, without the editor's checks on the folder's
 * origin or the token: tests of the pipeline set the project up and move on. Call after
 * `loadFactory` and `saveLinearKey`.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { ensureDefaultProject, listProjects } from '@/lib/projects';
import type { FactoryProject } from '@/lib/schemas';
import { getTracker, readBackMapping } from '@/lib/tracker';
import { SCRIPTED_PROJECTS, SCRIPTED_TEAM } from '@/lib/tracker/scripted';

/** The scripted team's statuses, one per pipeline state. */
export const SCRIPTED_MAPPING = {
  spec_ready: 'st_spec',
  approved: 'st_todo',
  building: 'st_progress',
  merge_question: 'st_review',
  done: 'st_done',
  needs_you: 'st_blocked',
};

/** The Linear project the Default project files into in tests: Web app. */
export const TEST_LINEAR_PROJECT = SCRIPTED_PROJECTS[0]!;

export async function setUpProject(
  db: Db,
  opts: {
    label?: string;
    states?: Record<string, string>;
    linearProject?: { id: string; name: string };
    github?: Partial<FactoryProject['github']>;
  } = {},
): Promise<FactoryProject> {
  await ensureDefaultProject(db);
  const [project] = await listProjects(db);
  if (!project) throw new Error('Load the factory first: there is no project.');
  const read = await readBackMapping(await getTracker(db), {
    teamId: SCRIPTED_TEAM.id,
    label: opts.label ?? 'magpipe',
    states: opts.states ?? SCRIPTED_MAPPING,
  });
  const [row] = await db
    .update(t.factoryProjects)
    .set({
      linear: {
        team: read.team,
        project: opts.linearProject ?? TEST_LINEAR_PROJECT,
        label: { id: read.label.id, name: read.label.name },
        states: read.states,
      },
      github: { ...project.github, ...opts.github },
      updatedAt: new Date(),
    })
    .where(eq(t.factoryProjects.id, project.id))
    .returning();
  // The next check reads every labelled issue of the new mapping.
  await db.update(t.linearSettings).set({ lastCheckAt: null });
  return row!;
}
