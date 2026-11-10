'use client';

import SegmentedControl from '@/components/arc/segmented-control/segmented-control';

export type FilterOption<K extends string> = { key: K; label: string; count?: number };

/** Views of one list (all · running · done …) as Arc's segmented control, counts beside the labels. */
export function FilterControl<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly FilterOption<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <SegmentedControl
      label={label}
      value={value}
      onValueChange={(next) => onChange(next as K)}
      options={options.map((o) => ({
        value: o.key,
        label: o.label,
        accessory:
          o.count !== undefined ? (
            <span className="font-mono text-caption text-mute tabular-nums">{o.count}</span>
          ) : undefined,
      }))}
    />
  );
}
