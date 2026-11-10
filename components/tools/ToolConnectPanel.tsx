'use client';

import { useId, useMemo, useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import type { McpProbe } from '@/lib/mcp';
import type { Tool } from '@/lib/schemas';
import { CONNECT_EXAMPLE, parseConnectJson } from '@/lib/tools-util';

type Props = {
  onClose: () => void;
  onConnected: (tool: Tool, probe: McpProbe) => void;
  secretsReady: boolean;
};

/**
 * The inline connect panel (spec §3.5): a JSON editor pre-filled with the example, validated as
 * you type, and one button that saves the tool with whatever the connection test found.
 */
export function ToolConnectPanel({ onClose, onConnected, secretsReady }: Props) {
  const ids = useId();
  const [text, setText] = useState(CONNECT_EXAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseConnectJson(text), [text]);
  const wantsToken = parsed.ok && parsed.data.auth.token !== undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ tool: Tool; probe: McpProbe }>('/api/tools', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      onConnected(result.tool, result.probe);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connecting failed. Try again.');
      setBusy(false);
    }
  }

  const hint = `name · transport (http or stdio) · url or command · auth { type, token? } · grant [agent slugs]. ${
    wantsToken && !secretsReady
      ? 'Tokens can’t be stored until MAGPIPE_SECRET_KEY is set.'
      : 'A token is stored encrypted and never shown again.'
  }`;

  return (
    <section
      id="connect-panel"
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 card p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${ids}-title`} className="text-display-sm text-ink-strong">
          Connect an MCP server
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex size-8 items-center justify-center rounded-pill border border-hairline text-mute hover:text-ink-strong"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Textarea
          label="Connection JSON"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={8}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
          aria-invalid={!parsed.ok}
          aria-describedby={`${ids}-hint`}
        />
        <p
          id={`${ids}-hint`}
          className={clsx('-mt-2 text-caption', parsed.ok ? 'text-mute' : 'text-danger')}
        >
          {parsed.ok ? hint : parsed.error}
        </p>
        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!parsed.ok || (wantsToken && !secretsReady)}
            loading={busy}
          >
            Connect & test
          </Button>
        </div>
      </form>
    </section>
  );
}
