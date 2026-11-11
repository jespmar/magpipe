'use client';

import { loadFactoryAction } from '@/app/(shell)/settings/actions';
import { RosterForm } from './RosterForm';

type Props = {
  /** The scripts the form starts with, from lib/factory.ts. */
  defaultScripts: string[];
  /** When set, the action is unavailable and this says why. */
  disabledReason?: string;
};

/** Load the software factory's nine agents (D37) onto a repository folder. */
export function FactoryForm({ defaultScripts, disabledReason }: Props) {
  return (
    <RosterForm
      load={loadFactoryAction}
      idPrefix="factory"
      defaultScripts={defaultScripts}
      label="Load the software factory"
      confirmLabel="Load the factory"
      confirm={(folder) => (
        <>
          This binds {folder} as a repository tool if it is not bound yet, and adds or rewrites the
          nine factory agents with their prompts and grants on it. They run only from templates, so
          the orchestrator never puts them in its own plans. The development flock and anything else
          you made are left alone.
        </>
      )}
      scriptsHint="Names from its package.json, separated by commas. The Test Agent and the Code Agent run them as the checks."
      noScripts="Name at least one script, such as test: the Test Agent runs the checks."
      agentsHref="/agents?agent=spec-builder"
      disabledReason={disabledReason}
    />
  );
}
