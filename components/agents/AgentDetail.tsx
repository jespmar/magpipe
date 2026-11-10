'use client';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextBlock } from '@/components/ui/TextBlock';
import { StatTile } from '@/components/ui/StatTile';
import type { AgentRow, NamespaceOption, ToolOption } from '@/lib/agents';
import { describeMemoryScope, formatPercent } from '@/lib/agents-util';
import { formatTokens } from '@/lib/format';

/** The selected bird in full (spec §3.3, right column). */
export function AgentDetail({
  agent,
  tools,
  namespaces,
  onEdit,
  onTogglePause,
  busy,
}: {
  agent: AgentRow;
  tools: ToolOption[];
  namespaces: NamespaceOption[];
  onEdit: () => void;
  onTogglePause: () => void;
  busy: boolean;
}) {
  const paused = agent.status === 'paused';
  const grants = agent.tools
    .map((g) => ({ tool: tools.find((x) => x.id === g.toolId), scopes: g.scopes }))
    .filter((g): g is { tool: ToolOption; scopes: string[] } => g.tool !== undefined);

  return (
    <aside
      aria-labelledby="agent-detail-name"
      className="flex min-w-0 flex-[1_1_380px] flex-col gap-4 card p-5 wide:flex-[0_1_600px]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar initials={agent.initials} size={44} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="agent-detail-name" className="truncate text-display-sm text-ink-strong">
              {agent.name}
            </h2>
            <span className="text-caption text-mute">{agent.role}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onTogglePause}
            disabled={busy}
            aria-label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      {agent.description ? (
        <p className="max-w-[31rem] text-body-sm text-body">{agent.description}</p>
      ) : null}

      <dl className="grid grid-cols-3 divide-x divide-hairline-soft border-y border-hairline-soft">
        <StatTile value={String(agent.stats.runs7d)} label="runs, 7 days" />
        <StatTile value={formatPercent(agent.stats.successPct)} label="success" />
        <StatTile
          value={agent.stats.avgTokens === null ? '—' : formatTokens(agent.stats.avgTokens)}
          label="avg tokens"
        />
      </dl>

      <section aria-labelledby="agent-tools-label" className="flex flex-col gap-2">
        <h3 id="agent-tools-label" className="text-body-sm font-medium text-ink">
          Tools
        </h3>
        {grants.length + agent.builtins.length === 0 ? (
          <p className="text-body-sm text-mute">No tools granted.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {agent.builtins.map((b) => (
              <li
                key={b}
                className="rounded-sm bg-canvas-soft px-2 py-0.5 font-mono text-code text-ink"
              >
                {b}
              </li>
            ))}
            {grants.map(({ tool, scopes }) => (
              <li
                key={tool.id}
                className="rounded-sm bg-canvas-soft px-2 py-0.5 font-mono text-code text-ink"
                title={scopes.length ? `${tool.name}: ${scopes.join(', ')}` : tool.name}
              >
                {tool.slug}
                {scopes.length ? <span className="text-mute"> · {scopes.join(' ')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="agent-memory-label" className="flex flex-col gap-2">
        <h3 id="agent-memory-label" className="text-body-sm font-medium text-ink">
          Memory scope
        </h3>
        <p className="text-body-sm text-ink">
          {describeMemoryScope(agent.memoryScope, namespaces)}
        </p>
      </section>

      <TextBlock
        title="System prompt"
        text={agent.systemPrompt || '(no system prompt yet)'}
        copyLabel="Copy prompt"
      />
    </aside>
  );
}
