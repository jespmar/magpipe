import type { ReactNode } from 'react';

type PageHeadProps = {
  eyebrow: string;
  title: string;
  description?: string;
  /** Mono facts line under the title, e.g. `flight_8f3972 · done · 11:05`. */
  meta?: string;
  /** Search input, primary action, … — right-aligned, wraps under the title when narrow. */
  actions?: ReactNode;
};

/** A single short word would split two-tone under the gradient; render it solid instead. */
const SOLID_EYEBROW_MAX = 8;

/** Eyebrow + h1 + one-liner, shared by every screen head (Agents, Runs, Tools, Memory). */
export function PageHead({ eyebrow, title, description, meta, actions }: PageHeadProps) {
  const solid = eyebrow.trim().length <= SOLID_EYEBROW_MAX;
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="eyebrow" data-solid={solid ? '' : undefined}>
          {eyebrow}
        </span>
        <h1 className="page-title">{title}</h1>
        {meta ? <p className="font-mono text-code text-mute">{meta}</p> : null}
        {description ? <p className="max-w-[31rem] text-body-sm text-body">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}
