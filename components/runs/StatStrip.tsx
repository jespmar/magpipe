import { formatCount } from '@/lib/format';
import { formatDurationWords, formatUsd, type RunsStats } from '@/lib/runs-util';

/**
 * The Runs screen's four numbers (spec §3.4): runs today · succeeded 7d · median duration ·
 * spend today, in one bordered group with hairline dividers. A number that cannot be computed
 * yet says so with a dash rather than a false zero.
 */
export function StatStrip({ stats }: { stats: RunsStats }) {
  const tiles = [
    { value: formatCount(stats.runsToday), label: 'runs today' },
    {
      value: stats.successPct7d === null ? '—' : `${stats.successPct7d}%`,
      label: 'succeeded, 7 days',
    },
    {
      value: stats.medianDurationMs === null ? '—' : formatDurationWords(stats.medianDurationMs),
      label: 'median duration',
    },
    { value: formatUsd(stats.spendToday), label: 'spend today' },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden card bg-hairline-soft md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="flex flex-col-reverse gap-0.5 bg-canvas-raised px-5 py-4">
          <dt className="text-caption text-mute">{t.label}</dt>
          <dd className="m-0 font-mono text-display-md font-medium text-ink-strong tabular-nums">
            {t.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
