'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Textarea } from '@/components/arc/textarea/textarea';
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

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Add or edit a fact (spec §3.6) in Arc's dialog, so focus is held while five fields are
 * filled. Adding under an existing namespace/key writes a new version of that fact.
 */
export function MemoryEditor({ entry, namespaces, defaultNs, onClose, onSaved }: Props) {
  const [open, setOpen] = useState(true);
  const keyRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(entry, defaultNs, namespaces));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function dismiss() {
    setOpen(false);
    onClose();
  }

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
        setOpen(false);
        onSaved(reviveEntry(saved), false);
      } else {
        const res = await api<{ entry: MemoryEntryJson; created: boolean }>('/api/memory', {
          method: 'POST',
          body: JSON.stringify(parsed.data),
        });
        setOpen(false);
        onSaved(reviveEntry(res.entry), res.created);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Saving failed. Try again.');
      setBusy(false);
    }
  }

  const title = entry ? `Edit ${entry.key}` : 'Add a fact';

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent
        title={title}
        style={{ width: 'min(calc(100vw - 2rem), 640px)' }}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // A new fact starts at its key, an existing one at its value; never at the close control.
          e.preventDefault();
          (entry ? valueRef : keyRef).current?.focus();
        }}
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Select
              label="Namespace"
              value={draft.ns}
              onValueChange={(value) => set('ns', value)}
              disabled={entry !== null}
              options={namespaces.map((ns) => ({ value: ns.id, label: ns.label }))}
            />
            <Input
              ref={keyRef}
              label="Key"
              description={
                entry
                  ? 'Fixed for an existing fact. Add a new fact to move it.'
                  : 'Dotted and stable, e.g. visma.salesorder.rpm'
              }
              style={MONO}
              value={draft.key}
              onChange={(e) => set('key', e.target.value)}
              disabled={entry !== null}
              spellCheck={false}
            />
          </div>

          <Textarea
            ref={valueRef}
            label="Value"
            rows={4}
            value={draft.value}
            onChange={(e) => set('value', e.target.value)}
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Confidence"
              description="0 to 1"
              type="number"
              min={0}
              max={1}
              step={0.01}
              style={MONO}
              value={draft.confidence}
              onChange={(e) => set('confidence', e.target.value)}
            />
            <Input
              label="Source"
              value={draft.source}
              onChange={(e) => set('source', e.target.value)}
            />
            <Input
              label="Expires"
              description="Leave empty for never"
              inputMode="numeric"
              placeholder="2026-12-06"
              style={MONO}
              value={draft.expiresAt}
              onChange={(e) => set('expiresAt', e.target.value)}
            />
          </div>

          <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-3 border-t border-hairline bg-canvas-soft px-6 py-4">
            {error ? (
              <p role="alert" className="text-body-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" onClick={dismiss} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {entry ? 'Save changes' : 'Add fact'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
