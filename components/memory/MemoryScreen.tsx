'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from 'react';
import { PageHead } from '@/components/ui/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DemoLink } from '@/components/ui/DemoLink';
import { EmptyState } from '@/components/ui/EmptyState';
import { SearchInput } from '@/components/ui/SearchInput';
import { MemoryDetail } from './MemoryDetail';
import { MemoryEditor } from './MemoryEditor';
import { MemoryTable } from './MemoryTable';
import { NamespaceNav } from './NamespaceNav';
import { NestHealth } from './NestHealth';
import { api } from '@/lib/client-api';
import type { NamespaceCount } from '@/lib/memory';
import {
  matchesMemoryQuery,
  reviveEntry,
  STANDING_NS,
  standingReach,
  summarizeHealth,
  type AuthorChip,
  type MemoryEntryJson,
} from '@/lib/memory-util';
import type { MemoryEntry, MemoryNamespace } from '@/lib/schemas';

type Props = {
  entries: MemoryEntry[];
  namespaces: NamespaceCount[];
  agents: AuthorChip[];
  /** From `?ns=`, `?id=` and `?new=1`. */
  initialNs?: string;
  initialId?: string;
  openNew?: boolean;
  fresh: boolean;
};

type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: string };

type Optimistic =
  | { type: 'upsert'; entry: MemoryEntry }
  | { type: 'remove'; id: string }
  | { type: 'namespace'; namespace: MemoryNamespace };

type Model = { entries: MemoryEntry[]; namespaces: NamespaceCount[] };

function applyOptimistic(state: Model, action: Optimistic): Model {
  switch (action.type) {
    case 'upsert': {
      const entries = state.entries.some((e) => e.id === action.entry.id)
        ? state.entries.map((e) => (e.id === action.entry.id ? action.entry : e))
        : [action.entry, ...state.entries];
      return { ...state, entries };
    }
    case 'remove':
      return { ...state, entries: state.entries.filter((e) => e.id !== action.id) };
    case 'namespace':
      return {
        ...state,
        namespaces: [...state.namespaces, { ...action.namespace, count: 0 }].sort((a, b) =>
          a.label.localeCompare(b.label),
        ),
      };
  }
}

/** The Memory screen (spec §3.6): namespaces and health, the ledger, one fact in full. */
export function MemoryScreen({
  entries: serverEntries,
  namespaces: serverNamespaces,
  agents,
  initialNs,
  initialId,
  openNew,
  fresh,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [ns, setNs] = useState<string | null>(() =>
    initialNs && serverNamespaces.some((n) => n.id === initialNs) ? initialNs : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => serverEntries.find((e) => e.id === initialId)?.id ?? null,
  );
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const status = useRef<HTMLParagraphElement>(null);
  const [model, optimistic] = useOptimistic<Model, Optimistic>(
    { entries: serverEntries, namespaces: serverNamespaces },
    applyOptimistic,
  );
  // One clock per render keeps "stale" and "updated" consistent across the three columns.
  const now = useMemo(() => new Date(), [model.entries]); // eslint-disable-line react-hooks/exhaustive-deps

  // The editor is a client-side dialog: `?new=1` opens it after hydration, never before.
  useEffect(() => {
    if (openNew) setEditor({ mode: 'create' });
  }, [openNew]);

  const namespaces = useMemo(
    () =>
      model.namespaces.map((n) => ({
        ...n,
        count: model.entries.filter((e) => e.ns === n.id).length,
      })),
    [model],
  );
  const health = useMemo(() => summarizeHealth(model.entries, now), [model.entries, now]);
  const visible = useMemo(
    () => model.entries.filter((e) => (ns === null || e.ns === ns) && matchesMemoryQuery(e, query)),
    [model.entries, ns, query],
  );
  const selected = model.entries.find((e) => e.id === selectedId) ?? null;
  const selectedVisible =
    selected && visible.some((e) => e.id === selected.id) ? selected : (visible[0] ?? null);

  function pickNamespace(next: string | null) {
    setNs(next);
    setSelectedId(null);
  }

  function settle(action: Optimistic, text: string) {
    startTransition(() => {
      optimistic(action);
      setNotice(text);
      router.refresh();
    });
  }

  function onSaved(entry: MemoryEntry, created: boolean) {
    setEditor({ mode: 'closed' });
    if (ns !== null && ns !== entry.ns) setNs(entry.ns);
    setSelectedId(entry.id);
    status.current?.focus();
    settle(
      { type: 'upsert', entry },
      created ? 'Fact added.' : `${entry.key} now has a new version.`,
    );
  }

  function verify(entry: MemoryEntry) {
    setNotice(null);
    startTransition(async () => {
      try {
        const res = await api<{ entry: MemoryEntryJson }>(`/api/memory/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ verified: true }),
        });
        const saved = reviveEntry(res.entry);
        startTransition(() => settle({ type: 'upsert', entry: saved }, `${entry.key} verified.`));
      } catch (err) {
        startTransition(() =>
          setNotice(err instanceof Error ? err.message : 'That did not work. Try again.'),
        );
      }
    });
  }

  function forget(entry: MemoryEntry) {
    setNotice(null);
    startTransition(async () => {
      try {
        await api(`/api/memory/${entry.id}`, { method: 'DELETE' });
        startTransition(() => {
          optimistic({ type: 'remove', id: entry.id });
          setSelectedId(null);
          setNotice(`${entry.key} forgotten.`);
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

  async function createNamespace(label: string) {
    setNotice(null);
    try {
      const res = await api<{
        namespace: Omit<MemoryNamespace, 'createdAt'> & { createdAt: string };
      }>('/api/memory/namespaces', { method: 'POST', body: JSON.stringify({ label }) });
      const namespace: MemoryNamespace = {
        ...res.namespace,
        createdAt: new Date(res.namespace.createdAt),
      };
      startTransition(() => {
        optimistic({ type: 'namespace', namespace });
        setNs(namespace.id);
        setSelectedId(null);
        setNotice(`Namespace “${res.namespace.label}” added.`);
        router.refresh();
      });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That did not work. Try again.');
    }
  }

  const empty = model.entries.length === 0;

  return (
    <>
      <PageHead
        title="Memory"
        description="The shiny bits the flock brings back: durable facts, decisions and limits every bird reads before it flies."
        actions={
          <>
            {/* Lives in the head so a notice never moves the columns below. */}
            <p
              ref={status}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              className="text-body-sm text-mute focus:outline-none"
            >
              {pending ? 'Updating…' : notice}
            </p>
            <SearchInput
              label="Search memory"
              placeholder="Search the nest…"
              value={query}
              onChange={setQuery}
              className="w-[260px]"
            />
            <Button variant="primary" onClick={() => setEditor({ mode: 'create' })}>
              Add fact
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-start gap-6">
        <aside className="flex min-w-0 flex-[1_1_240px] flex-col gap-4 md:max-w-[300px] wide:max-w-[340px] wide:flex-[0_1_300px]">
          <NamespaceNav
            namespaces={namespaces}
            total={model.entries.length}
            value={ns}
            onChange={pickNamespace}
            onCreate={createNamespace}
            busy={pending}
          />
          <NestHealth health={health} />
        </aside>

        <section
          aria-label="Entries"
          className="flex min-w-0 flex-[1_1_560px] flex-col gap-5 wide:flex-[1_1_1100px] wide:flex-row wide:flex-wrap wide:items-start wide:gap-6"
        >
          {empty ? (
            <EmptyState
              title="The nest is empty"
              description="Every durable fact a bird learns is kept here with its confidence, source and expiry. Add a decision of your own with “Add fact”."
              actions={fresh ? <DemoLink /> : undefined}
            />
          ) : (
            <>
              {ns === STANDING_NS ? (
                // Decisions are the operator's standing instructions: say where they go (D34).
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 wide:basis-full">
                  <p className="text-body-sm text-body">
                    {standingReach(namespaces.find((n) => n.id === STANDING_NS)?.count ?? 0)}
                  </p>
                  <ButtonLink href="/settings#orchestrator" variant="ghost" size="sm">
                    See the orchestrator’s rules
                  </ButtonLink>
                </div>
              ) : null}
              <div className="min-w-0 wide:flex-[2_1_600px]">
                <MemoryTable
                  entries={visible}
                  agents={agents}
                  selectedId={selectedVisible?.id ?? null}
                  onSelect={setSelectedId}
                  now={now}
                  emptyMessage={
                    query
                      ? `No memories match “${query}”.`
                      : 'Nothing in this namespace yet. Add a fact to start it.'
                  }
                />
              </div>
              {selectedVisible ? (
                <div className="min-w-0 wide:flex-[0_1_440px]">
                  <MemoryDetail
                    entry={selectedVisible}
                    agents={agents}
                    now={now}
                    onEdit={() => setEditor({ mode: 'edit', id: selectedVisible.id })}
                    onVerify={() => verify(selectedVisible)}
                    onForget={() => forget(selectedVisible)}
                    busy={pending}
                  />
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {editor.mode !== 'closed' ? (
        <MemoryEditor
          key={editor.mode === 'edit' ? editor.id : 'new'}
          entry={
            editor.mode === 'edit' ? (model.entries.find((e) => e.id === editor.id) ?? null) : null
          }
          namespaces={namespaces}
          defaultNs={ns}
          onClose={() => setEditor({ mode: 'closed' })}
          onSaved={onSaved}
        />
      ) : null}
    </>
  );
}
