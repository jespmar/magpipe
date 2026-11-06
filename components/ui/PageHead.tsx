import type { ReactNode } from 'react';

type PageHeadProps = {
  eyebrow: string;
  title: string;
  description?: string;
  /** Search input, primary action, … — right-aligned, wraps under the title when narrow. */
  actions?: ReactNode;
};

/** Eyebrow + h1 + one-liner, shared by every screen head (Agents, Runs, Tools, Memory). */
export function PageHead({ eyebrow, title, description, actions }: PageHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="max-w-2xl text-body-sm text-body">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}
