import { formatCount } from '@/lib/format';
import { formatDurationWords, formatUsd, type RunsStats } from '@/lib/runs-util';

/**
 * The Runs screen's four tiles (spec §3.4): runs today · succeeded 7d · median duration · spend
 * today. A number that cannot be computed yet says so with a dash rather than a false zero.
 */
export function StatStrip({ stats }: { stats: RunsStats }) {
  const tiles = [
    { value: formatCount(stats.runsToday), label: 'runs today' },
    {
      value: stats.successPct7d === null ? '—' : `${stats.successPct7d}%`,
      label: 'succeeded · 7d',
    },
    {
      value: stats.medianDurationMs === null ? '—' : formatDurationWords(stats.medianDurationMs),
      label: 'median duration',
    },
    { value: formatUsd(stats.spendToday), label: 'spend today' },
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="flex flex-col-reverse gap-0.5 rounded-md border border-hairline bg-(image:--g-card) p-4"
        >
          <dt className="text-caption text-mute">{t.label}</dt>
          <dd className="m-0 font-mono text-[24px] leading-8 font-[550] text-ink-strong">
            {t.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
