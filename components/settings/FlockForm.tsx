'use client';

import { plural } from '@/lib/format';
import { loadFlockAction } from '@/app/(shell)/settings/actions';
import { RosterForm } from './RosterForm';

type Props = {
  /** The scripts the form starts with, from lib/flock.ts. */
  defaultScripts: string[];
  /** How many `decisions` entries the flock writes, so the confirm copy cannot drift. */
  decisions: number;
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

/** Load the development flock (D35) onto a repository folder. */
export function FlockForm({ defaultScripts, decisions, disabledReason }: Props) {
  return (
    <RosterForm
      load={loadFlockAction}
      idPrefix="flock"
      defaultScripts={defaultScripts}
      label="Load the development flock"
      confirmLabel="Load the flock"
      confirm={(folder) => (
        <>
          This binds {folder} and its docs/plans folder as repository tools, adds Planner and
          Verifier, gives Researcher, Coder and Reviewer new prompts, memory and grants on those
          folders, writes {plural(decisions, 'decisions entry', 'decisions entries')} and pauses
          Operator. Grants to other tools, and anything else you made, are left alone.
        </>
      )}
      scriptsHint="Names from its package.json, separated by commas. The Verifier runs them as the checks."
      noScripts="Name at least one script, such as test: the Verifier runs the checks."
      agentsHref="/agents?agent=planner"
      disabledReason={disabledReason}
    />
  );
}
