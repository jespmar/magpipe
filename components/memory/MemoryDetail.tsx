'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { StatusPill } from '@/components/ui/StatusPill';
import {
  authorLabel,
  formatConfidence,
  formatExpires,
  isExpired,
  isStale,
  rawJson,
  type AuthorChip,
} from '@/lib/memory-util';
import { shortWhen } from '@/lib/format';
import type { MemoryEntry } from '@/lib/schemas';

type Props = {
  entry: MemoryEntry;
  agents: AuthorChip[];
  now: Date;
  onEdit: () => void;
  onVerify: () => void;
  onForget: () => void;
  busy: boolean;
};

/** One fact in full: provenance, trust, and the raw record (spec §3.6). */
export function MemoryDetail({ entry, agents, now, onEdit, onVerify, onForget, busy }: Props) {
  const [confirm, setConfirm] = useState(false);
  const stale = isStale(entry, now);
  const expired = isExpired(entry, now);
  const readBy = entry.readBy.map((id) => authorLabel(id, agents));

  return (
    <aside aria-labelledby="memory-detail-value" className="flex min-w-0 flex-col gap-4 card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-code text-mute">
            {entry.ns} / {entry.key}
          </span>
          <h2 id="memory-detail-value" className="text-body-lg font-medium text-ink-strong">
            {entry.value}
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirm(true)}
            disabled={busy || confirm}
          >
            Forget
          </Button>
        </div>
      </div>

      {entry.conflict || stale || expired ? (
        <div className="flex flex-wrap gap-2">
          {entry.conflict ? <StatusPill variant="conflict" label="conflict" /> : null}
          {stale ? <StatusPill variant="stale" label="stale" /> : null}
          {expired ? <StatusPill variant="expired" label="expired" /> : null}
        </div>
      ) : null}

      <dl className="flex flex-wrap gap-x-6 gap-y-3">
        <Fact label="Confidence" value={formatConfidence(entry.confidence)} />
        <Fact label="Source" value={entry.source} />
        <Fact label="Written by" value={authorLabel(entry.writtenBy, agents)} />
        <Fact label="Read by" value={readBy.length ? readBy.join(', ') : '—'} />
        <Fact label="Expires" value={formatExpires(entry.expiresAt)} />
        <Fact label="Verified" value={shortWhen(entry.verifiedAt, now)} />
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onVerify} disabled={busy}>
          Mark verified
        </Button>
        {entry.conflict ? (
          <span className="text-caption text-mute">
            A write moved confidence by more than 0.3; verifying settles it.
          </span>
        ) : stale ? (
          <span className="text-caption text-mute">Last verified more than 30 days ago.</span>
        ) : null}
      </div>

      {confirm ? (
        <div
          role="group"
          aria-label="Forget this memory"
          className="flex flex-wrap items-center gap-2 border-t border-hairline-soft pt-3 text-body-sm text-ink"
        >
          Forget {entry.key}? Every agent stops reading it.
          <Button variant="danger" size="sm" onClick={onForget} disabled={busy}>
            Forget
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>
            Keep
          </Button>
        </div>
      ) : null}

      <CodeBlock filename="Raw" language="json" code={rawJson(entry, agents)} maxLines={16} />
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption text-mute">{label}</dt>
      <dd className="m-0 font-mono text-code text-ink-strong">{value}</dd>
    </div>
  );
}
