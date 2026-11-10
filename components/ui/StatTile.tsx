/**
 * A mono number over its caption. Tiles sit flat on their parent surface, divided by
 * hairlines rather than boxed: no card inside a card. A value with nothing behind it reads
 * "—", never a false zero.
 */
export function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5 px-4 py-3 first:pl-0 last:pr-0">
      <dt className="text-caption text-mute">{label}</dt>
      <dd className="m-0 font-mono text-display-sm font-medium text-ink-strong tabular-nums">
        {value}
      </dd>
    </div>
  );
}
