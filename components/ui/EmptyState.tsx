import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  /** What will appear here and what the operator can do now — product voice, no build talk. */
  children: ReactNode;
  /** Real facts from the workspace, shown in mono and joined with " · ". */
  facts?: string[];
  /** Links to places that exist today. Never a control that leads nowhere. */
  actions?: ReactNode;
};

/**
 * The honest state of a screen whose body is not built yet, or that has nothing in it. Says
 * what this screen is for and offers a real next step.
 */
export function EmptyState({ title, children, facts, actions }: EmptyStateProps) {
  return (
    <section
      aria-labelledby="empty-state-title"
      className="flex flex-col gap-4 panel px-6 py-8 md:px-8"
    >
      <h2 id="empty-state-title" className="text-display-sm text-ink-strong">
        {title}
      </h2>
      {/* ~72 characters of Inter at 16px; `ch` overshoots because Inter is narrower than its 0. */}
      <div className="max-w-[34rem] text-body-md text-body">{children}</div>
      {facts && facts.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-code text-mute">
          {facts.map((fact, i) => (
            <li key={fact} className="flex items-baseline gap-3">
              {i > 0 ? (
                <span aria-hidden className="text-hairline">
                  ·
                </span>
              ) : null}
              {fact}
            </li>
          ))}
        </ul>
      ) : null}
      {actions ? <div className="flex flex-wrap gap-3 pt-2">{actions}</div> : null}
    </section>
  );
}
