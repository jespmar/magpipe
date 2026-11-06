import type { ReactNode } from 'react';

type PlaceholderProps = {
  /** Which build-order PR fills this in (docs/spec.md §10). */
  pr: number;
  /** Spec section, e.g. "§3.3". */
  spec: string;
  /** Artboard(s) on the design canvas. */
  artboards: string;
  children?: ReactNode;
};

/** Scaffold stand-in for a screen body. Delete once the screen ships. */
export function Placeholder({ pr, spec, artboards, children }: PlaceholderProps) {
  return (
    <section className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-hairline px-6 py-12 text-center">
      <span className="label-caps">Lands in PR {pr}</span>
      <p className="max-w-md text-body-sm text-body">
        Built from spec {spec} and the{' '}
        <span className="font-mono text-code text-code-ink">{artboards}</span> artboards.
      </p>
      {children}
    </section>
  );
}
