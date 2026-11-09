'use client';

import { useState, type FormEvent } from 'react';
import { clsx } from 'clsx';
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
      'flex w-full items-center justify-between gap-2 rounded-sm border-l-2 px-3 py-2.5 text-left text-body-sm transition-colors focus-visible:-outline-offset-3',
      on
        ? 'border-l-cyan bg-[rgba(34,193,220,0.06)] font-semibold text-ink-strong'
        : 'border-l-transparent text-body hover:bg-[rgba(255,255,255,0.03)] hover:text-ink',
    );

  return (
    <nav
      aria-label="Namespaces"
      className="flex flex-col gap-0.5 rounded-md border border-hairline bg-(image:--g-card) p-2"
    >
      <span className="px-3 pt-2 pb-1.5 label-caps">Namespaces</span>
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={row(value === null)}
      >
        <span>All</span>
        <span className="font-mono text-caption text-mute">{total}</span>
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
            <span className="font-mono text-caption text-mute">{ns.count}</span>
          </button>
        );
      })}
      {adding ? (
        <form onSubmit={submit} className="flex flex-col gap-2 px-3 pt-2 pb-1">
          <label htmlFor="new-namespace" className="text-caption font-medium text-body">
            New namespace
          </label>
          <div className="flex gap-2">
            <input
              id="new-namespace"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              maxLength={40}
              className="min-w-0 flex-1 rounded-sm border border-hairline bg-canvas-soft px-3 py-1.5 text-body-sm text-ink focus:border-ink-strong focus:outline-none"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !label.trim()}>
              Add
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1 rounded-sm px-3 py-2 text-left text-caption font-medium text-ghost hover:text-ink-strong"
        >
          + New namespace
        </button>
      )}
    </nav>
  );
}
