import type { ReactNode } from 'react';
import { Unplug } from 'lucide-react';
import { EmptyState as ArcEmptyState } from '@/components/arc/empty-state/empty-state';

type EmptyStateProps = {
  title: string;
  /** Why it is empty and what to do next, in product voice. One or two sentences. */
  description: string;
  /** Real facts from the workspace, in mono. Precise nouns (agents, runs, memories). */
  facts?: string[];
  /** Links to places that exist today. Never a control that leads nowhere. */
  actions?: ReactNode;
  icon?: ReactNode;
  /** Accessible name for the region. */
  label?: string;
};

/**
 * The honest state of a screen that has nothing in it yet: Arc's empty state with the facts
 * line and the one real next step underneath.
 */
export function EmptyState({ title, description, facts, actions, icon, label }: EmptyStateProps) {
  const extra =
    (facts && facts.length > 0) || actions ? (
      <div className="flex flex-col items-center gap-4">
        {facts && facts.length > 0 ? (
          <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 font-mono text-code text-mute">
            {facts.map((fact) => (
              <li key={fact} className="whitespace-nowrap">
                {fact}
              </li>
            ))}
          </ul>
        ) : null}
        {actions ? <div className="flex flex-wrap justify-center gap-3">{actions}</div> : null}
      </div>
    ) : undefined;
  return (
    <ArcEmptyState
      title={title}
      description={description}
      icon={icon}
      label={label}
      action={extra}
      className="card"
    />
  );
}

/**
 * What every screen shows when the database cannot be opened: the data is not gone, it just
 * cannot be read right now. The notice above carries the cause and the remedy.
 */
export function UnavailableState() {
  return (
    <ArcEmptyState
      icon={<Unplug size={24} strokeWidth={1.75} />}
      title="This screen can’t be read right now"
      description="Your data is still there. Magpipe can’t open its database at the moment; the notice at the top of the page says why and how to fix it."
      label="Database unavailable"
      className="card"
    />
  );
}
