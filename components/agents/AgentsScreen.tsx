'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useOptimistic, useState, useTransition } from 'react';
import { PageHead } from '@/components/ui/PageHead';
import { Button } from '@/components/ui/Button';
import { FilterPills } from '@/components/ui/FilterPills';
import { SearchInput } from '@/components/ui/SearchInput';
import { AgentDetail } from './AgentDetail';
import { AgentEditor } from './AgentEditor';
import { AgentList } from './AgentList';
import type { AgentRow, NamespaceOption, ToolOption } from '@/lib/agents';
import {
  AGENT_FILTERS,
  matchesFilter,
  matchesQuery,
  type AgentFilter,
  type AgentStats,
} from '@/lib/agents-util';
import { api } from '@/lib/client-api';
import type { Agent, AgentStatus } from '@/lib/schemas';

type Props = {
  agents: AgentRow[];
  tools: ToolOption[];
  namespaces: NamespaceOption[];
  models: string[];
  defaultModel: string;
  /** From `?agent=<slug>` and `?new=1`. */
  initialSlug?: string;
  openNew?: boolean;
};

type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: string };

/** What the operator just did, shown at once while the server re-reads the roster. */
type Optimistic =
  | { type: 'status'; id: string; status: AgentStatus }
  | { type: 'upsert'; agent: AgentRow }
  | { type: 'remove'; id: string };

const NO_STATS: AgentStats = { runs7d: 0, successPct: null, avgTokens: null };

function applyOptimistic(state: AgentRow[], action: Optimistic): AgentRow[] {
  switch (action.type) {
    case 'status':
      return state.map((a) => (a.id === action.id ? { ...a, status: action.status } : a));
    case 'upsert':
      return state.some((a) => a.id === action.agent.id)
        ? state.map((a) => (a.id === action.agent.id ? action.agent : a))
        : [...state, action.agent].sort((a, b) => a.name.localeCompare(b.name));
    case 'remove':
      return state.filter((a) => a.id !== action.id);
  }
}

/** The Agents screen (spec §3.3): head, filter pills, roster and detail, plus the editor. */
export function AgentsScreen({
  agents: serverAgents,
  tools,
  namespaces,
  models,
  defaultModel,
  initialSlug,
  openNew,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(
    () => serverAgents.find((a) => a.slug === initialSlug)?.id ?? serverAgents[0]?.id ?? null,
  );
  const [editor, setEditor] = useState<EditorState>(
    openNew ? { mode: 'create' } : { mode: 'closed' },
  );
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  // The optimistic roster holds what the operator just did until the refreshed server data lands.
  const [agents, optimistic] = useOptimistic(serverAgents, applyOptimistic);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        AGENT_FILTERS.map((f) => [
          f.key,
          agents.filter((a) => matchesFilter(a.status, f.key)).length,
        ]),
      ) as Record<AgentFilter, number>,
    [agents],
  );

  const visible = useMemo(
    () => agents.filter((a) => matchesFilter(a.status, filter) && matchesQuery(a, query)),
    [agents, filter, query],
  );

  // Keep the selection valid as the list changes (after a save, a delete or a filter).
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const selectedVisible =
    selected && visible.some((a) => a.id === selected.id) ? selected : (visible[0] ?? null);

  /**
   * The address after an edit: `?new=1` has done its job, and `?agent=` names the bird to land on.
   * Only ever applied through the router. A bare `history.replaceState` would leave the router's
   * tree keyed on the old search params, and every later refresh would land in the wrong slot.
   */
  function addressFor(slug: string | null) {
    const params = new URLSearchParams(window.location.search);
    params.delete('new');
    if (slug) params.set('agent', slug);
    else params.delete('agent');
    const search = params.toString();
    return search ? `${pathname}?${search}` : pathname;
  }

  /** Re-read the roster from the server; navigate instead when the address has to change. */
  function reload(target: string) {
    if (target === window.location.pathname + window.location.search) router.refresh();
    else router.replace(target, { scroll: false });
  }

  function closeEditor() {
    setEditor({ mode: 'closed' });
    if (new URLSearchParams(window.location.search).has('new')) {
      startTransition(() =>
        router.replace(addressFor(selectedVisible?.slug ?? null), { scroll: false }),
      );
    }
  }

  function togglePause(agent: AgentRow) {
    const status: AgentStatus = agent.status === 'paused' ? 'idle' : 'paused';
    setNotice(null);
    startTransition(async () => {
      optimistic({ type: 'status', id: agent.id, status });
      try {
        await api(`/api/agents/${agent.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        startTransition(() => {
          setNotice(`${agent.name} ${status === 'paused' ? 'paused' : 'resumed'}.`);
          router.refresh();
        });
      } catch (err) {
        startTransition(() => {
          setNotice(err instanceof Error ? err.message : 'That did not work. Try again.');
        });
      }
    });
  }

  function onSaved(saved: Agent) {
    const wasCreate = editor.mode === 'create';
    setEditor({ mode: 'closed' });
    startTransition(() => {
      const stats = agents.find((a) => a.id === saved.id)?.stats ?? NO_STATS;
      optimistic({ type: 'upsert', agent: { ...saved, stats } });
      setSelectedId(saved.id);
      setNotice(wasCreate ? 'Added to the flock.' : 'Changes saved.');
      reload(addressFor(saved.slug));
    });
  }

  function onRemoved(id: string) {
    setEditor({ mode: 'closed' });
    startTransition(() => {
      optimistic({ type: 'remove', id });
      setSelectedId(null);
      setNotice('Removed from the flock.');
      reload(addressFor(null));
    });
  }

  return (
    <>
      <PageHead
        eyebrow="The flock"
        title="Agents"
        description="Every bird Magpipe can send out — what it does, what it may touch, and how it has been flying."
        actions={
          <>
            <SearchInput
              label="Search agents"
              placeholder="Search agents…"
              value={query}
              onChange={setQuery}
            />
            <Button variant="primary" onClick={() => setEditor({ mode: 'create' })}>
              + Add a bird
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          label="Filter agents by status"
          options={AGENT_FILTERS.map((f) => ({ ...f, count: counts[f.key] }))}
          value={filter}
          onChange={setFilter}
        />
        <p role="status" aria-live="polite" className="text-body-sm text-mute">
          {pending ? 'Updating…' : notice}
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <AgentList
          agents={visible}
          selectedId={selectedVisible?.id ?? null}
          onSelect={setSelectedId}
          emptyMessage={
            agents.length === 0
              ? 'No birds in the flock yet. Add one to get started.'
              : query
                ? `No agents match “${query}”.`
                : 'No agents with this status.'
          }
        />
        {selectedVisible ? (
          <AgentDetail
            agent={selectedVisible}
            tools={tools}
            namespaces={namespaces}
            onEdit={() => setEditor({ mode: 'edit', id: selectedVisible.id })}
            onTogglePause={() => togglePause(selectedVisible)}
            busy={pending}
          />
        ) : null}
      </div>

      {editor.mode !== 'closed' ? (
        <AgentEditor
          key={editor.mode === 'edit' ? editor.id : 'new'}
          agent={editor.mode === 'edit' ? (agents.find((a) => a.id === editor.id) ?? null) : null}
          tools={tools}
          namespaces={namespaces}
          models={models}
          defaultModel={defaultModel}
          onClose={closeEditor}
          onSaved={onSaved}
          onRemoved={onRemoved}
        />
      ) : null}
    </>
  );
}
