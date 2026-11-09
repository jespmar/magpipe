'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
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

/**
 * The agent editor (spec §5.7): a native `<dialog>` so focus is trapped and Escape closes it.
 * One form, grouped as the detail panel is: identity, model and prompt, tools, memory, limits.
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
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(agent, defaultModel));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

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
      onRemoved(agent.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deleting failed. Try again.');
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 text-body-sm text-ink focus:border-ink-strong focus:outline-none';
  const title = agent ? `Edit ${agent.name}` : 'Add a bird';

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={`${ids}-title`}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(760px,calc(100vw-32px))] overflow-y-auto rounded-md border border-hairline bg-(image:--g-card) p-0 text-ink accent-accent backdrop:bg-[rgba(16,16,16,0.72)] backdrop:backdrop-blur-sm"
    >
      <form onSubmit={submit} noValidate className="flex flex-col">
        <div className="flex flex-col gap-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={`${ids}-title`} className="text-display-md text-ink-strong">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center rounded-pill border border-hairline text-mute hover:text-ink-strong"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <Fieldset legend="Identity">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_88px]">
              <Field id={`${ids}-name`} label="Name">
                <input
                  id={`${ids}-name`}
                  className={field}
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  required
                  data-autofocus=""
                />
              </Field>
              <Field
                id={`${ids}-role`}
                label="Role"
                hint="A few words, e.g. “Gathers context & sources”"
              >
                <input
                  id={`${ids}-role`}
                  className={field}
                  value={draft.role}
                  onChange={(e) => set('role', e.target.value)}
                />
              </Field>
              <Field id={`${ids}-initials`} label="Initials">
                <input
                  id={`${ids}-initials`}
                  className={clsx(field, 'font-mono uppercase')}
                  value={draft.initials}
                  placeholder={initialsOf(draft.name)}
                  maxLength={3}
                  onChange={(e) => set('initials', e.target.value)}
                />
              </Field>
            </div>
            <Field id={`${ids}-desc`} label="Description">
              <textarea
                id={`${ids}-desc`}
                className={clsx(field, 'min-h-16 resize-y')}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
          </Fieldset>

          <Fieldset legend="Model and prompt">
            <Field id={`${ids}-model`} label="Model">
              <div className="relative">
                <select
                  id={`${ids}-model`}
                  className={clsx(field, 'appearance-none pr-9 font-mono')}
                  value={draft.model}
                  onChange={(e) => set('model', e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <svg
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 text-mute"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            </Field>
            <Field id={`${ids}-prompt`} label="System prompt">
              <textarea
                id={`${ids}-prompt`}
                className={clsx(field, 'min-h-32 resize-y font-mono text-code')}
                value={draft.systemPrompt}
                onChange={(e) => set('systemPrompt', e.target.value)}
                placeholder={`You are ${draft.name || 'a bird'} in the Magpipe flock.\n…`}
              />
            </Field>
          </Fieldset>

          <Fieldset legend="Tools" hint="Nothing is reachable unless it is granted here.">
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {builtinTools.map((b) => (
                <Check
                  key={b}
                  label={<span className="font-mono text-code">{b}</span>}
                  checked={draft.builtins.includes(b)}
                  onChange={(on) =>
                    set(
                      'builtins',
                      on ? [...draft.builtins, b] : draft.builtins.filter((x) => x !== b),
                    )
                  }
                />
              ))}
            </div>
            {tools.length === 0 ? (
              <p className="text-caption text-mute">
                No connected tools yet — connect some on the Tools screen.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-hairline-soft rounded-md border border-hairline">
                {tools.map((tool) => {
                  const grant = draft.tools.find((g) => g.toolId === tool.id);
                  return (
                    <li key={tool.id} className="flex flex-col gap-2 px-3 py-2.5">
                      <Check
                        label={
                          <>
                            <span className="text-body-sm text-ink">{tool.name}</span>{' '}
                            <span className="font-mono text-caption text-mute">{tool.slug}</span>
                          </>
                        }
                        checked={grant !== undefined}
                        onChange={(on) => toggleGrant(tool, on)}
                      />
                      {grant && tool.scopes.length > 0 ? (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
                          {tool.scopes.map((scope) => (
                            <Check
                              key={scope}
                              label={<span className="font-mono text-code">{scope}</span>}
                              checked={grant.scopes.includes(scope)}
                              onChange={(on) => toggleScope(tool.id, scope, on)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Fieldset>

          <Fieldset legend="Memory scope" hint="Which namespaces the bird may read and write.">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="label-caps">
                  <th scope="col" className="pb-2 text-left font-semibold">
                    Namespace
                  </th>
                  <th scope="col" className="pb-2 text-center font-semibold">
                    Read
                  </th>
                  <th scope="col" className="pb-2 text-center font-semibold">
                    Write
                  </th>
                </tr>
              </thead>
              <tbody>
                {namespaces.map((ns) => (
                  <tr key={ns.id} className="border-t border-hairline-soft">
                    <td className="py-2 text-ink">{ns.label}</td>
                    {(['read', 'write'] as const).map((kind) => (
                      <td key={kind} className="py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${kind === 'read' ? 'Read' : 'Write'} ${ns.label}`}
                          className="size-4"
                          checked={draft.memoryScope[kind].includes(ns.id)}
                          onChange={(e) => toggleNamespace(ns.id, kind, e.target.checked)}
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
                <Field key={key} id={`${ids}-${key}`} label={label}>
                  <input
                    id={`${ids}-${key}`}
                    type="number"
                    min={1}
                    className={clsx(field, 'font-mono')}
                    value={draft.limits[key]}
                    onChange={(e) =>
                      set('limits', { ...draft.limits, [key]: Number(e.target.value) })
                    }
                  />
                </Field>
              ))}
            </div>
          </Fieldset>
        </div>

        {/* The commit row stays in view however long the form is; errors sit beside it. */}
        <div className="sticky bottom-0 flex flex-col gap-3 border-t border-hairline bg-canvas px-6 py-4">
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
                    Remove {agent.name} from the flock?
                    <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
                      {busy ? 'Removing…' : 'Remove'}
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
                    Remove from the flock
                  </Button>
                )
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
                {busy ? 'Saving…' : agent ? 'Save changes' : 'Add to the flock'}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </dialog>
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
      <legend className="mb-3 label-caps">{legend}</legend>
      {hint ? <p className="-mt-1 text-caption text-mute">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-caption font-medium text-body">
        {label}
      </label>
      {children}
      {hint ? <span className="text-caption text-mute">{hint}</span> : null}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
