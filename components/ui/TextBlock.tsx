'use client';

import { CopyButton } from '@/components/arc/copy-button/copy-button';

/**
 * Prose that is also data (a system prompt): mono, wrapped, with Arc's copy button in a header
 * shaped like the code block's. Code and JSON use `CodeBlock`; this is for text that is not code.
 */
export function TextBlock({
  title,
  text,
  copyLabel = 'Copy text',
  maxHeight = 320,
}: {
  title: string;
  text: string;
  /** The copy button's label, a verb and its object ("Copy prompt"). */
  copyLabel?: string;
  maxHeight?: number;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-hairline bg-canvas-raised"
    >
      <header className="flex min-h-[52px] items-center justify-between gap-3 border-b border-hairline-soft py-2 pr-2 pl-5">
        <span className="text-body-sm font-medium text-ink">{title}</span>
        <CopyButton value={text} label={copyLabel} variant="plain" />
      </header>
      <pre
        className="m-0 overflow-auto px-5 py-4 font-mono text-code leading-relaxed whitespace-pre-wrap text-ink"
        style={{ maxHeight }}
      >
        {text}
      </pre>
    </section>
  );
}
