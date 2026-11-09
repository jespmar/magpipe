'use client';

import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** react-markdown hands each element its AST node; the DOM must not receive it. */
function omitNode<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const rest: T = { ...props };
  delete (rest as { node?: unknown }).node;
  return rest;
}

/** The merged result in the system's own type: Inter at body sizes, mono for code, cyan links. */
const components: Components = {
  h1: (p) => <h3 className="text-display-sm text-ink-strong" {...omitNode(p)} />,
  h2: (p) => <h3 className="text-display-sm text-ink-strong" {...omitNode(p)} />,
  h3: (p) => <h4 className="text-body-lg font-semibold text-ink-strong" {...omitNode(p)} />,
  h4: (p) => <h5 className="text-body-md font-semibold text-ink-strong" {...omitNode(p)} />,
  h5: (p) => <h6 className="text-body-md font-semibold text-ink-strong" {...omitNode(p)} />,
  h6: (p) => <h6 className="text-body-sm font-semibold text-ink-strong" {...omitNode(p)} />,
  p: (p) => <p className="text-body-md text-body" {...omitNode(p)} />,
  ul: (p) => (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-body-md text-body" {...omitNode(p)} />
  ),
  ol: (p) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-body-md text-body" {...omitNode(p)} />
  ),
  li: (p) => <li className="pl-1 [&>p]:inline" {...omitNode(p)} />,
  a: (p) => (
    <a
      className="text-cyan underline underline-offset-4 hover:text-ink-strong"
      target="_blank"
      rel="noreferrer"
      {...omitNode(p)}
    />
  ),
  strong: (p) => <strong className="font-semibold text-ink-strong" {...omitNode(p)} />,
  code: (p) => (
    <code
      className="rounded-xs bg-canvas-soft px-1 py-0.5 font-mono text-[0.9em] text-code-ink [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-code"
      {...omitNode(p)}
    />
  ),
  pre: (p) => (
    <pre
      className="overflow-x-auto rounded-md border border-hairline bg-canvas p-4 font-mono text-code text-code-ink"
      {...omitNode(p)}
    />
  ),
  blockquote: (p) => (
    <blockquote
      className="border-l-2 border-hairline pl-4 text-body-md text-body"
      {...omitNode(p)}
    />
  ),
  hr: (p) => <hr className="border-hairline" {...omitNode(p)} />,
  table: (p) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-body-sm text-body" {...omitNode(p)} />
    </div>
  ),
  th: (p) => <th className="pr-4 pb-2 label-caps" {...omitNode(p)} />,
  td: (p) => <td className="border-t border-hairline-soft py-2 pr-4 align-top" {...omitNode(p)} />,
};

/** The flight's merged result, rendered from markdown (spec §3.4). Raw HTML is never rendered. */
export function RunOutput({ markdown }: { markdown: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
