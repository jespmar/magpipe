'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Textarea } from '@/components/arc/textarea/textarea';
import { Button } from '@/components/ui/Button';
import type { NamespaceOption, ToolOption } from '@/lib/agents';
import { initialsOf } from '@/lib/agents-util';
import { api, ApiError } from '@/lib/client-api';
import { agentInput, builtinTools, type Agent, type AgentInput } from '@/lib/schemas';

type Props = {
  /** `null` = create a new bird. */
  agent: Agent | null;
  tools: ToolOption[];
  namespaces: NamespaceOption[];
  models: string[];
  defaultModel: string;
  onClose: () => void;
  /** Called with the saved agent once the server has it. */
  onSaved: (agent: Agent) => void;
  /** Called once the server has removed the agent. */
  onRemoved: (id: string) => void;
};

type Draft = AgentInput & { initials: string };

function draftFrom(agent: Agent | null, defaultModel: string): Draft {
  if (!agent) {
    return {
      name: '',
      role: '',
      description: '',
      initials: '',
      model: defaultModel,
      systemPrompt: '',
      tools: [],
      builtins: [],
      memoryScope: { read: [], write: [] },
      limits: { maxTokens: 100_000, maxSteps: 30, timeoutSec: 600 },
    };
  }
  const {
    name,
    role,
    description,
    initials,
    model,
    systemPrompt,
    tools,
    builtins,
    memoryScope,
    limits,
  } = agent;
  return {
    name,
    role,
    description,
    initials,
    model,
    systemPrompt,
    tools,
    builtins,
    memoryScope,
    limits,
  };
}

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * The agent editor (spec §5.7) in Arc's dialog: focus is trapped, Escape closes it and focus
 * returns. One form, grouped as the detail panel is: identity, model and prompt, tools, memory,
 * limits.
 */
export function AgentEditor({
  agent,
  tools,
  namespaces,
  models,
  defaultModel,
  onClose,
  onSaved,
  onRemoved,
}: Props) {
  const ids = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(agent, defaultModel));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** Closing goes through the dialog, so the exit plays before the parent unmounts it. */
  function dismiss() {
    setOpen(false);
    onClose();
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  function toggleGrant(tool: ToolOption, granted: boolean) {
    set(
      'tools',
      granted
        ? [
            ...draft.tools.filter((g) => g.toolId !== tool.id),
            { toolId: tool.id, scopes: [...tool.scopes] },
          ]
        : draft.tools.filter((g) => g.toolId !== tool.id),
    );
  }

  function toggleScope(toolId: string, scope: string, on: boolean) {
    set(
      'tools',
      draft.tools.map((g) =>
        g.toolId === toolId
          ? { ...g, scopes: on ? [...g.scopes, scope] : g.scopes.filter((s) => s !== scope) }
          : g,
      ),
    );
  }

  function toggleNamespace(ns: string, kind: 'read' | 'write', on: boolean) {
    const list = draft.memoryScope[kind];
    set('memoryScope', {
      ...draft.memoryScope,
      [kind]: on ? [...list, ns] : list.filter((x) => x !== ns),
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = { ...draft, initials: draft.initials.trim() || undefined };
    const parsed = agentInput.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }
    setBusy(true);
    try {
      const res = agent
        ? await api<{ agent: Agent }>(`/api/agents/${agent.id}`, {
            method: 'PATCH',
            body: JSON.stringify(parsed.data),
          })
        : await api<{ agent: Agent }>('/api/agents', {
            method: 'POST',
            body: JSON.stringify(parsed.data),
          });
      setOpen(false);
      onSaved(res.agent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Saving failed. Try again.');
      setBusy(false);
    }
  }

  async function remove() {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      setOpen(false);
      onRemoved(agent.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deleting failed. Try again.');
      setBusy(false);
    }
  }

  const title = agent ? `Edit ${agent.name}` : 'Add a bird';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent
        title={title}
        style={{ width: 'min(calc(100vw - 2rem), 760px)' }}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          <Fieldset legend="Identity">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px]">
              <Input
                ref={nameRef}
                label="Name"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                required
              />
              <Input
                label="Role"
                description="A few words, e.g. “Gathers context and sources”"
                value={draft.role}
                onChange={(e) => set('role', e.target.value)}
              />
              <Input
                label="Initials"
                style={MONO}
                value={draft.initials}
                placeholder={initialsOf(draft.name)}
                maxLength={3}
                onChange={(e) => set('initials', e.target.value.toUpperCase())}
              />
            </div>
            <Textarea
              label="Description"
              rows={2}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Fieldset>

          <Fieldset legend="Model and prompt">
            <Select
              label="Model"
              value={draft.model}
              onValueChange={(value) => set('model', value)}
              options={models.map((m) => ({ value: m, label: m }))}
            />
            <Textarea
              label="System prompt"
              rows={6}
              style={MONO}
              value={draft.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              placeholder={`You are ${draft.name || 'a bird'} in the Magpipe flock.\n…`}
            />
          </Fieldset>

          <Fieldset legend="Tools" hint="Nothing is reachable unless it is granted here.">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {builtinTools.map((b) => (
                <Checkbox
                  key={b}
                  label={b}
                  checked={draft.builtins.includes(b)}
                  onCheckedChange={(on) =>
                    set(
                      'builtins',
                      on === true ? [...draft.builtins, b] : draft.builtins.filter((x) => x !== b),
                    )
                  }
                />
              ))}
            </div>
            {tools.length === 0 ? (
              <p className="text-caption text-mute">
                No connected tools yet. Connect some on the Tools screen.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline-soft rounded-[max(6px,calc(var(--radius-surface)-24px))] border border-hairline">
                {tools.map((tool) => {
                  const grant = draft.tools.find((g) => g.toolId === tool.id);
                  return (
                    <li key={tool.id} className="flex flex-col gap-1 px-2 py-1">
                      <Checkbox
                        label={tool.name}
                        description={tool.slug}
                        checked={grant !== undefined}
                        onCheckedChange={(on) => toggleGrant(tool, on === true)}
                      />
                      {grant && tool.scopes.length > 0 ? (
                        <div className="flex flex-wrap gap-x-2 pl-9">
                          {tool.scopes.map((scope) => (
                            <Checkbox
                              key={scope}
                              label={scope}
                              checked={grant.scopes.includes(scope)}
                              onCheckedChange={(on) => toggleScope(tool.id, scope, on === true)}
                            />
                          ))}
                        </div>
                      ) : null}
                      {grant ? <GrantNote toolScopes={tool.scopes} granted={grant.scopes} /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Fieldset>

          <Fieldset legend="Memory scope" hint="Which namespaces the bird may read and write.">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-caption font-medium text-mute">
                  <th scope="col" className="pb-2 text-left font-medium">
                    Namespace
                  </th>
                  <th scope="col" className="pb-2 text-center font-medium">
                    Read
                  </th>
                  <th scope="col" className="pb-2 text-center font-medium">
                    Write
                  </th>
                </tr>
              </thead>
              <tbody>
                {namespaces.map((ns) => (
                  <tr key={ns.id} className="border-t border-hairline-soft">
                    <td className="py-1 text-ink">{ns.label}</td>
                    {(['read', 'write'] as const).map((kind) => (
                      <td key={kind} className="py-1 text-center">
                        <Checkbox
                          aria-label={`${kind === 'read' ? 'Read' : 'Write'} ${ns.label}`}
                          checked={draft.memoryScope[kind].includes(ns.id)}
                          onCheckedChange={(on) => toggleNamespace(ns.id, kind, on === true)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Fieldset>

          <Fieldset
            legend="Limits"
            hint="A step that exceeds one of these fails instead of running on."
          >
            <div className="grid grid-cols-3 gap-4">
              {(
                [
                  ['maxTokens', 'Max tokens'],
                  ['maxSteps', 'Max steps'],
                  ['timeoutSec', 'Timeout (s)'],
                ] as const
              ).map(([key, label]) => (
                <Input
                  key={key}
                  id={`${ids}-${key}`}
                  label={label}
                  type="number"
                  min={1}
                  style={MONO}
                  value={draft.limits[key]}
                  onChange={(e) =>
                    set('limits', { ...draft.limits, [key]: Number(e.target.value) })
                  }
                />
              ))}
            </div>
          </Fieldset>

          {/* The commit row stays in view however long the form is; errors sit beside it. */}
          <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-3 border-t border-hairline bg-canvas-soft px-6 py-4">
            {error ? (
              <p role="alert" className="text-body-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {agent ? (
                  confirmDelete ? (
                    <span className="flex flex-wrap items-center gap-2 text-body-sm text-ink">
                      Remove {agent.name}?
                      <Button variant="danger" size="sm" onClick={remove} loading={busy}>
                        Remove
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(false)}
                        disabled={busy}
                      >
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(true)}
                      disabled={busy}
                    >
                      Remove agent
                    </Button>
                  )
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={dismiss} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  {agent ? 'Save changes' : 'Add agent'}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Fieldset({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 text-body-md font-medium text-ink-strong">{legend}</legend>
      {hint ? <p className="-mt-1 text-caption text-mute">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

/** What an empty grant means, said where it is made (D25). */
function GrantNote({ toolScopes, granted }: { toolScopes: string[]; granted: string[] }) {
  if (toolScopes.length === 0) {
    return (
      <p className="pb-1 pl-9 text-caption text-mute">
        Its tools are not known yet. This agent gets all of them once the server answers a test on
        the Tools screen.
      </p>
    );
  }
  if (granted.length === 0) {
    return (
      <p className="pb-1 pl-9 text-caption text-mute">
        Nothing ticked, so this agent gets no tools from this server.
      </p>
    );
  }
  return null;
}
