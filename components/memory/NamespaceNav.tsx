'use client';

import { useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
import { Input } from '@/components/arc/input/input';
import { Button } from '@/components/ui/Button';
import type { NamespaceCount } from '@/lib/memory';

type Props = {
  namespaces: NamespaceCount[];
  total: number;
  /** `null` = every namespace. */
  value: string | null;
  onChange: (ns: string | null) => void;
  onCreate: (label: string) => Promise<void>;
  busy: boolean;
};

/** The left column's first card (spec §3.6): what kinds of knowledge the nest holds. */
export function NamespaceNav({ namespaces, total, value, onChange, onCreate, busy }: Props) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    await onCreate(label.trim());
    setLabel('');
    setAdding(false);
  }

  const row = (on: boolean) =>
    clsx(
      'flex w-full items-center justify-between gap-2 rounded-(--radius-control) px-3 py-2.5 text-left text-body-sm transition-colors',
      on
        ? 'bg-cyan-soft font-medium text-ink-strong'
        : 'text-body hover:bg-canvas-muted hover:text-ink',
    );

  return (
    <nav aria-label="Namespaces" className="flex flex-col gap-0.5 card p-2">
      <span className="px-3 pt-2 pb-1.5 text-body-sm font-medium text-ink">Namespaces</span>
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={row(value === null)}
      >
        <span>All</span>
        <span className="font-mono text-caption text-mute tabular-nums">{total}</span>
      </button>
      {namespaces.map((ns) => {
        const on = value === ns.id;
        return (
          <button
            key={ns.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(ns.id)}
            className={row(on)}
          >
            <span className="truncate">{ns.label}</span>
            <span className="font-mono text-caption text-mute tabular-nums">{ns.count}</span>
          </button>
        );
      })}
      {adding ? (
        <form onSubmit={submit} className="flex flex-col gap-3 px-2 pt-3 pb-1">
          <Input
            id="new-namespace"
            label="New namespace"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
            maxLength={40}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" size="sm" disabled={busy || !label.trim()}>
              Add namespace
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="pt-1">
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            New namespace
          </Button>
        </div>
      )}
    </nav>
  );
}
