import { clsx } from 'clsx';
import type { NestHealthSummary } from '@/lib/memory-util';

/** The left column's second card (spec §3.6): how much of the nest can be trusted. */
export function NestHealth({ health }: { health: NestHealthSummary }) {
  const pct = health.verifiedPct;
  const Row = ({
    label,
    value,
    tone,
  }: {
    label: string;
    value: number;
    tone?: 'warn' | 'danger';
  }) => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-body-sm text-body">{label}</dt>
      <dd
        className={clsx(
          'm-0 font-mono text-code',
          tone === 'warn' && value > 0
            ? 'text-warn'
            : tone === 'danger' && value > 0
              ? 'text-danger'
              : 'text-ink-strong',
        )}
      >
        {value}
      </dd>
    </div>
  );
  return (
    <section
      aria-labelledby="nest-health"
      className="flex flex-col gap-3 rounded-md border border-hairline bg-(image:--g-card) p-4"
    >
      <h2 id="nest-health" className="label-caps">
        Nest health
      </h2>
      <dl className="flex flex-col gap-3">
        <Row label="Facts" value={health.facts} />
        <Row label="Stale (> 30 d)" value={health.stale} tone="warn" />
        <Row label="Conflicts" value={health.conflicts} tone="danger" />
        {health.expired > 0 ? <Row label="Expired" value={health.expired} /> : null}
      </dl>
      <div
        role="meter"
        aria-label="Facts verified in the last 30 days"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        className="h-1 overflow-hidden rounded-pill bg-canvas-soft"
      >
        <div
          className="h-full rounded-pill bg-(image:--g-progress)"
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <p className="text-caption text-mute">
        {pct === null ? 'Nothing to verify yet.' : `${pct}% of facts verified in the last 30 days`}
      </p>
    </section>
  );
}
