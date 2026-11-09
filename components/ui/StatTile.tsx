/**
 * A mono number over a caption label (spec §5.11). Tiles sit flat on their parent surface,
 * separated by hairlines rather than boxed: no card inside a card.
 */
export function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5 px-4 py-3 first:pl-0 last:pr-0">
      <dt className="text-caption text-mute">{label}</dt>
      <dd className="m-0 font-mono text-display-sm font-[550] text-ink-strong">{value}</dd>
    </div>
  );
}
