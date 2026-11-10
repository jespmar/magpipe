'use client';

import { useId, useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { Input } from '@/components/arc/input/input';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import type { AgentChip } from '@/lib/tools';
import { formatCount } from '@/lib/format';
import type { Tool } from '@/lib/schemas';
import { kindLabel, TOOL_STATUS } from '@/lib/tools-util';

type Props = {
  tool: Tool;
  agents: AgentChip[];
  /** The card whose management strip is unfolded. */
  open: boolean;
  onToggle: () => void;
  onTest: () => void;
  onToken: (token: string) => void;
  onRemove: () => void;
  busy: boolean;
  /** Whether this process can store a pasted token (MAGPIPE_SECRET_KEY). */
  secretsReady: boolean;
};

/** One integration: glyph, name, kind, status, reach, who holds it (spec §3.5). */
export function ToolCard({
  tool,
  agents,
  open,
  onToggle,
  onTest,
  onToken,
  onRemove,
  busy,
  secretsReady,
}: Props) {
  const ids = useId();
  const [mode, setMode] = useState<'actions' | 'token' | 'confirm'>('actions');
  const [token, setToken] = useState('');
  const status = TOOL_STATUS[tool.status];
  const holders = tool.grantedAgents
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentChip => a !== undefined);
  const builtin = tool.kind === 'builtin';
  const canAuth = !builtin && tool.auth.type !== 'none';

  function toggle() {
    setMode('actions');
    setToken('');
    onToggle();
  }

  function submitToken(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    onToken(token.trim());
    setToken('');
    setMode('actions');
  }

  return (
    <article
      aria-labelledby={`${ids}-name`}
      className="flex min-w-0 flex-1 flex-col gap-3 card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar initials={tool.glyph} size={36} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={`${ids}-name`} className="truncate text-body-md font-medium text-ink-strong">
              {tool.name}
            </h2>
            <span className="text-caption text-mute">{kindLabel(tool)}</span>
          </div>
        </div>
        <StatusPill variant={status.variant} label={status.label} />
      </div>

      <p className="text-body-sm text-body">{tool.description}</p>
      {tool.status !== 'connected' && tool.stats.lastError ? (
        <p className={clsx('text-caption', tool.status === 'error' ? 'text-danger' : 'text-warn')}>
          {tool.stats.lastError}
        </p>
      ) : null}

      {tool.scopes.length > 0 ? (
        <ul aria-label="Tool names" className="flex flex-wrap gap-1.5">
          {tool.scopes.map((scope) => (
            <li
              key={scope}
              className="rounded-sm bg-canvas-soft px-2 py-0.5 font-mono text-caption text-ink"
            >
              {scope}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-mute">No tool names discovered yet.</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-hairline-soft pt-2.5">
        <ul aria-label="Granted to" className="flex gap-1">
          {holders.length === 0 ? (
            <li className="text-caption text-mute">No agent holds this</li>
          ) : (
            holders.map((a) => (
              <li key={a.id} title={a.name}>
                <Avatar initials={a.initials} size={24} />
                <span className="sr-only">{a.name}</span>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-2">
          <span className="font-mono text-caption text-mute">
            {formatCount(tool.stats.calls24h)} calls · 24h
          </span>
          {builtin ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={toggle}
              aria-expanded={open}
              aria-controls={`${ids}-manage`}
            >
              {open ? 'Done' : 'Manage'}
            </Button>
          )}
        </div>
      </div>

      {open && !builtin ? (
        <div
          id={`${ids}-manage`}
          className="flex flex-col gap-3 border-t border-hairline-soft pt-3"
        >
          {mode === 'actions' ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={onTest} disabled={busy}>
                Test again
              </Button>
              {canAuth ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMode('token')}
                  disabled={busy}
                >
                  Re-authorise
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setMode('confirm')} disabled={busy}>
                Remove
              </Button>
            </div>
          ) : null}

          {mode === 'token' ? (
            <form onSubmit={submitToken} className="flex flex-col gap-3">
              <Input
                id={`${ids}-token`}
                label={tool.auth.type === 'apikey' ? 'API key' : 'Access token'}
                description={
                  secretsReady
                    ? 'Stored encrypted on this machine and sent only to this server.'
                    : 'Tokens can’t be stored until MAGPIPE_SECRET_KEY is set. See .env.example.'
                }
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={!secretsReady}
                autoFocus
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={busy || !secretsReady || !token.trim()}
                >
                  Save and test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode('actions')}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}

          {mode === 'confirm' ? (
            <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink">
              Remove {tool.name} and every agent’s grant to it?
              <Button variant="danger" size="sm" onClick={onRemove} disabled={busy}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('actions')} disabled={busy}>
                Keep
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
