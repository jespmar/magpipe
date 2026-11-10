'use client';

import { CodeBlock as ArcCodeBlock } from '@/components/arc/code-block/code-block';

/** Arc's code block: a header with the name and language, a Copy control, a fold for long sources. */
export function CodeBlock({
  code,
  filename,
  language = 'text',
  maxLines,
}: {
  code: string;
  /** Shown in the header, e.g. "System prompt". */
  filename: string;
  language?: 'text' | 'json' | 'markdown';
  maxLines?: number;
}) {
  return <ArcCodeBlock code={code} filename={filename} language={language} maxLines={maxLines} />;
}
