import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  /** What will appear here and what the operator can do now — product voice, no build talk. */
  children: ReactNode;
  /** Real facts from the workspace, in mono. Precise nouns (agents, runs, memories). */
  facts?: string[];
  /** Links to places that exist today. Never a control that leads nowhere. */
  actions?: ReactNode;
};

/**
 * The honest state of a screen whose body is not built yet, or that has nothing in it. Says
 * what this screen is for and offers a real next step. One column at a reading width on every
 * screen size, so the action always sits under the sentence it concludes.
 */
export function EmptyState({ title, children, facts, actions }: EmptyStateProps) {
  return (
    <section
      aria-labelledby="empty-state-title"
      className="flex max-w-[60rem] flex-col gap-4 panel px-6 py-8 md:px-8"
    >
      <h2 id="empty-state-title" className="text-display-sm text-ink-strong">
        {title}
      </h2>
      {/* ~72 characters of Inter at 16px; `ch` overshoots because Inter is narrower than its 0. */}
      <div className="max-w-[34rem] text-body-md text-body">{children}</div>
      {facts && facts.length > 0 ? (
        <ul className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-code text-mute">
          {facts.map((fact) => (
            <li key={fact} className="whitespace-nowrap">
              {fact}
            </li>
          ))}
        </ul>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-3 pt-2">{actions}</div> : null}
    </section>
  );
}

/**
 * What every screen shows when the database cannot be opened: the data is not gone, it just
 * cannot be read right now. The shell banner above carries the cause and the remedy.
 */
export function UnavailableState() {
  return (
    <section
      aria-labelledby="unavailable-title"
      className="flex max-w-[60rem] flex-col gap-4 panel px-6 py-8 md:px-8"
    >
      <h2 id="unavailable-title" className="text-display-sm text-ink-strong">
        This screen can’t be read right now
      </h2>
      <p className="max-w-[34rem] text-body-md text-body">
        Your data is still there — Magpipe just can’t open its database at the moment. The notice at
        the top of the page says why and how to fix it; this screen fills in as soon as it can read
        again.
      </p>
    </section>
  );
}
