import type { ReactNode } from 'react';

type PageHeadProps = {
  title: string;
  description?: string;
  /** Facts under the title (status pill, id, duration, …), laid out as one mono line. */
  meta?: ReactNode;
  /** Search field, primary action, … right-aligned, wrapping under the title when narrow. */
  actions?: ReactNode;
};

/** The one h1 of a screen, its description and its actions. No line above the title. */
export function PageHead({ title, description, meta, actions }: PageHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="page-title">{title}</h1>
        {meta ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-code text-mute">
            {meta}
          </div>
        ) : null}
        {description ? <p className="max-w-[31rem] text-body-sm text-body">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}
