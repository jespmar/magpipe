import { clsx } from 'clsx';
import { Progress } from '@/components/arc/progress/progress';
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
          'm-0 font-mono text-code tabular-nums',
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
    <section aria-labelledby="nest-health" className="flex flex-col gap-3 card p-4">
      <h2 id="nest-health" className="text-body-sm font-medium text-ink">
        Nest health
      </h2>
      <dl className="flex flex-col gap-3">
        <Row label="Facts" value={health.facts} />
        <Row label="Stale (over 30 days)" value={health.stale} tone="warn" />
        <Row label="Conflicts" value={health.conflicts} tone="danger" />
        {health.expired > 0 ? <Row label="Expired" value={health.expired} /> : null}
      </dl>
      <Progress
        value={pct ?? 0}
        label="Facts verified in the last 30 days"
        className="[&>div:first-child]:sr-only"
      />
      <p className="text-caption text-mute">
        {pct === null ? 'Nothing to verify yet.' : `${pct}% of facts verified in the last 30 days`}
      </p>
    </section>
  );
}
