'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import type { NamespaceCount } from '@/lib/memory';
import { formatExpires, reviveEntry, type MemoryEntryJson } from '@/lib/memory-util';
import { memoryInput, type MemoryEntry } from '@/lib/schemas';

type Props = {
  /** `null` = add a fact. */
  entry: MemoryEntry | null;
  namespaces: NamespaceCount[];
  /** Pre-selected namespace for a new fact. */
  defaultNs: string | null;
  onClose: () => void;
  onSaved: (entry: MemoryEntry, created: boolean) => void;
};

type Draft = {
  ns: string;
  key: string;
  value: string;
  confidence: string;
  source: string;
  expiresAt: string;
};

function draftFrom(
  entry: MemoryEntry | null,
  defaultNs: string | null,
  namespaces: NamespaceCount[],
): Draft {
  if (!entry) {
    return {
      ns: defaultNs ?? namespaces[0]?.id ?? '',
      key: '',
      value: '',
      confidence: '1',
      source: 'you',
      expiresAt: '',
    };
  }
  return {
    ns: entry.ns,
    key: entry.key,
    value: entry.value,
    confidence: String(entry.confidence),
    source: entry.source,
    expiresAt: entry.expiresAt ? formatExpires(entry.expiresAt) : '',
  };
}

/**
 * Add or edit a fact (spec §3.6): a native dialog so focus is held while five fields are
 * filled. Adding under an existing namespace/key writes a new version of that fact.
 */
export function MemoryEditor({ entry, namespaces, defaultNs, onClose, onSaved }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(entry, defaultNs, namespaces));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const confidence = Number(draft.confidence);
    const payload = {
      ns: draft.ns,
      key: draft.key,
      value: draft.value,
      confidence: Number.isFinite(confidence) ? confidence : -1,
      source: draft.source,
      expiresAt: draft.expiresAt.trim() ? draft.expiresAt.trim() : null,
    };
    const parsed = memoryInput.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === 'confidence'
          ? 'Confidence is a number between 0 and 1'
          : issue?.path[0] === 'expiresAt'
            ? 'Expiry is a date like 2026-12-06'
            : (issue?.message ?? 'Check the form'),
      );
      return;
    }
    setBusy(true);
    try {
      if (entry) {
        const { entry: saved } = await api<{ entry: MemoryEntryJson }>(`/api/memory/${entry.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            value: parsed.data.value,
            confidence: parsed.data.confidence,
            source: parsed.data.source,
            expiresAt: parsed.data.expiresAt,
          }),
        });
        onSaved(reviveEntry(saved), false);
      } else {
        const res = await api<{ entry: MemoryEntryJson; created: boolean }>('/api/memory', {
          method: 'POST',
          body: JSON.stringify(parsed.data),
        });
        onSaved(reviveEntry(res.entry), res.created);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Saving failed. Try again.');
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 text-body-sm text-ink focus:border-ink-strong focus:outline-none disabled:opacity-60';
  const title = entry ? `Edit ${entry.key}` : 'Add a fact';

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={`${ids}-title`}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] overflow-y-auto rounded-md border border-hairline bg-(image:--g-card) p-0 text-ink accent-accent backdrop:bg-[rgba(16,16,16,0.72)] backdrop:backdrop-blur-sm"
    >
      <form onSubmit={submit} noValidate className="flex flex-col">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={`${ids}-title`} className="truncate text-display-md text-ink-strong">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-pill border border-hairline text-mute hover:text-ink-strong"
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

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field id={`${ids}-ns`} label="Namespace">
              <div className="relative">
                <select
                  id={`${ids}-ns`}
                  className={clsx(field, 'appearance-none pr-9')}
                  value={draft.ns}
                  onChange={(e) => set('ns', e.target.value)}
                  disabled={entry !== null}
                >
                  {namespaces.map((ns) => (
                    <option key={ns.id} value={ns.id}>
                      {ns.label}
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
            <Field
              id={`${ids}-key`}
              label="Key"
              hint={entry ? undefined : 'Dotted and stable, e.g. visma.salesorder.rpm'}
            >
              <input
                id={`${ids}-key`}
                className={clsx(field, 'font-mono text-code')}
                value={draft.key}
                onChange={(e) => set('key', e.target.value)}
                disabled={entry !== null}
                data-autofocus={entry === null ? '' : undefined}
                spellCheck={false}
              />
            </Field>
          </div>

          <Field id={`${ids}-value`} label="Value">
            <textarea
              id={`${ids}-value`}
              className={clsx(field, 'min-h-24 resize-y')}
              value={draft.value}
              onChange={(e) => set('value', e.target.value)}
              data-autofocus={entry !== null ? '' : undefined}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`${ids}-confidence`} label="Confidence" hint="0 to 1">
              <input
                id={`${ids}-confidence`}
                type="number"
                min={0}
                max={1}
                step={0.01}
                className={clsx(field, 'font-mono')}
                value={draft.confidence}
                onChange={(e) => set('confidence', e.target.value)}
              />
            </Field>
            <Field id={`${ids}-source`} label="Source">
              <input
                id={`${ids}-source`}
                className={field}
                value={draft.source}
                onChange={(e) => set('source', e.target.value)}
              />
            </Field>
            <Field id={`${ids}-expires`} label="Expires" hint="Leave empty for never">
              <input
                id={`${ids}-expires`}
                inputMode="numeric"
                placeholder="2026-12-06"
                className={clsx(field, 'font-mono')}
                value={draft.expiresAt}
                onChange={(e) => set('expiresAt', e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="sticky bottom-0 flex flex-col gap-3 border-t border-hairline bg-canvas px-6 py-4">
          {error ? (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
              {busy ? 'Saving…' : entry ? 'Save changes' : 'Add to the nest'}
            </Button>
          </div>
        </div>
      </form>
    </dialog>
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
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-caption font-medium text-body">
        {label}
      </label>
      {children}
      {hint ? <span className="text-caption text-mute">{hint}</span> : null}
    </div>
  );
}
