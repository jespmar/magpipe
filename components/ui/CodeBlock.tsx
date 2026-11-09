'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** `<pre>` on the canvas with a hairline and a Copy control (spec §5.11). */
export function CodeBlock({
  code,
  label,
  heading,
  maxHeight = 180,
}: {
  code: string;
  /** Accessible name for the Copy button, e.g. "Copy system prompt". */
  label: string;
  /** Rendered on the left of the Copy row, usually the section's heading. */
  heading?: ReactNode;
  maxHeight?: number;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* clipboard unavailable: the text is selectable below */
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        {heading ?? <span />}
        <button
          type="button"
          onClick={copy}
          aria-label={label}
          className="rounded-xs text-caption font-medium text-ghost hover:text-ink-strong"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span role="status" className="sr-only">
          {copied ? 'Copied to clipboard' : ''}
        </span>
      </div>
      <pre
        className="m-0 overflow-auto rounded-md border border-hairline bg-canvas p-4 font-mono text-code whitespace-pre-wrap text-code-ink"
        style={{ maxHeight }}
      >
        {code}
      </pre>
    </div>
  );
}
