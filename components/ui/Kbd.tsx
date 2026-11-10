import type { ReactNode } from 'react';

/** A key cap: mono caption on a hairline chip. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded-sm border border-hairline bg-canvas-soft px-1.5 py-0.5 font-mono text-caption text-ink-strong">
      {children}
    </kbd>
  );
}
