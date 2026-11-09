'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react';
import { PageHead } from '@/components/ui/PageHead';
import { Button } from '@/components/ui/Button';
import { DemoLink } from '@/components/ui/DemoLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { SearchInput } from '@/components/ui/SearchInput';
import { ToolCard } from './ToolCard';
import { ToolConnectPanel } from './ToolConnectPanel';
import { api } from '@/lib/client-api';
import type { McpProbe } from '@/lib/mcp';
import type { Tool } from '@/lib/schemas';
import type { AgentChip } from '@/lib/tools';
import { describeProbe, matchesToolQuery } from '@/lib/tools-util';

type Props = {
  tools: Tool[];
  agents: AgentChip[];
  /** From `?connect=1`. */
  openConnect?: boolean;
  /** A workspace with nothing but the starter agents: offer the demo data. */
  fresh: boolean;
  secretsReady: boolean;
};

type Optimistic = { type: 'upsert'; tool: Tool } | { type: 'remove'; id: string };

function applyOptimistic(state: Tool[], action: Optimistic): Tool[] {
  switch (action.type) {
    case 'upsert':
      return state.some((x) => x.id === action.tool.id)
        ? state.map((x) => (x.id === action.tool.id ? action.tool : x))
        : [...state, action.tool].sort((a, b) => a.name.localeCompare(b.name));
    case 'remove':
      return state.filter((x) => x.id !== action.id);
  }
}

/** The Tools screen (spec §3.5): head, inline connect panel, the card grid. */
export function ToolsScreen({
  tools: serverTools,
  agents,
  openConnect,
  fresh,
  secretsReady,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  // The panel is a client-side toggle, so `?connect=1` opens it after hydration rather than
  // server-rendering a form that typing could reach before React does.
  const [panel, setPanel] = useState(false);
  useEffect(() => {
    if (openConnect) setPanel(true);
  }, [openConnect]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [pending, startTransition] = useTransition();
  const [tools, optimistic] = useOptimistic(serverTools, applyOptimistic);

  const visible = useMemo(() => tools.filter((x) => matchesToolQuery(x, query)), [tools, query]);

  /** `?connect=1` has done its job once the panel closes; a real navigation drops it. */
  function closePanel() {
    setPanel(false);
    if (new URLSearchParams(window.location.search).has('connect')) {
      startTransition(() => router.replace(pathname, { scroll: false }));
    }
  }

  function settle(tool: Tool, text: string) {
    startTransition(() => {
      optimistic({ type: 'upsert', tool });
      setNotice(text);
      router.refresh();
    });
  }

  function onConnected(tool: Tool, probe: McpProbe) {
    closePanel();
    settle(tool, describeProbe(probe, tool.name, true));
  }

  function test(tool: Tool) {
    setNotice(null);
    startTransition(async () => {
      try {
        const res = await api<{ tool: Tool; probe: McpProbe }>(`/api/tools/${tool.id}/test`, {
          method: 'POST',
        });
        startTransition(() => settle(res.tool, describeProbe(res.probe, res.tool.name, false)));
      } catch (err) {
        startTransition(() =>
          setNotice(err instanceof Error ? err.message : 'That did not work. Try again.'),
        );
      }
    });
  }

  function saveToken(tool: Tool, token: string) {
    setNotice(null);
    startTransition(async () => {
      try {
        const res = await api<{ tool: Tool; probe: McpProbe | null }>(`/api/tools/${tool.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ auth: { type: tool.auth.type, token } }),
        });
        startTransition(() =>
          settle(
            res.tool,
            res.probe ? describeProbe(res.probe, res.tool.name, false) : 'Token saved.',
          ),
        );
      } catch (err) {
        startTransition(() =>
          setNotice(err instanceof Error ? err.message : 'That did not work. Try again.'),
        );
      }
    });
  }

  function remove(tool: Tool) {
    setNotice(null);
    startTransition(async () => {
      try {
        await api(`/api/tools/${tool.id}`, { method: 'DELETE' });
        startTransition(() => {
          optimistic({ type: 'remove', id: tool.id });
          setOpenId(null);
          setNotice(`${tool.name} removed.`);
          // The card is gone; keyboard focus lands on the line that says so.
          status.current?.focus();
          router.refresh();
        });
      } catch (err) {
        startTransition(() =>
          setNotice(err instanceof Error ? err.message : 'That did not work. Try again.'),
        );
      }
    });
  }

  return (
    <>
      <PageHead
        eyebrow="Beaks & claws"
        title="Tools"
        description="MCP servers and integrations the flock can use. Each tool is scoped per bird — nothing is reachable unless it is granted here."
        actions={
          <>
            <SearchInput
              label="Search tools"
              placeholder="Search tools…"
              value={query}
              onChange={setQuery}
            />
            <Button
              variant="primary"
              onClick={() => setPanel((v) => !v)}
              aria-expanded={panel}
              aria-controls="connect-panel"
            >
              + Connect tool
            </Button>
          </>
        }
      />

      {panel ? (
        <ToolConnectPanel
          onClose={closePanel}
          onConnected={onConnected}
          secretsReady={secretsReady}
        />
      ) : null}

      <p
        ref={status}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="min-h-5 text-body-sm text-mute focus:outline-none"
      >
        {pending ? 'Updating…' : notice}
      </p>

      {tools.length === 0 ? (
        <EmptyState title="No tools connected yet" actions={fresh ? <DemoLink /> : undefined}>
          <p>
            Birds reach the world through tools: MCP servers you connect here, plus the built-ins
            (web search, file reading, a sandboxed workspace). Press “Connect tool”, paste a
            server’s JSON, and it is tested and listed in one go
            {fresh ? ', or load the demo data to look at nine examples' : ''}.
          </p>
        </EmptyState>
      ) : visible.length === 0 ? (
        <p className="text-body-sm text-body">No tools match “{query}”.</p>
      ) : (
        <ul className="grid items-start gap-5 md:grid-cols-2 lg:grid-cols-3 wide:grid-cols-4 wide:gap-6">
          {visible.map((tool) => (
            <li key={tool.id} className="flex min-w-0">
              <ToolCard
                tool={tool}
                agents={agents}
                open={openId === tool.id}
                onToggle={() => setOpenId((id) => (id === tool.id ? null : tool.id))}
                onTest={() => test(tool)}
                onToken={(token) => saveToken(tool, token)}
                onRemove={() => remove(tool)}
                busy={pending}
                secretsReady={secretsReady}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
