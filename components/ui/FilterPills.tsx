import { clsx } from 'clsx';

export type FilterOption<K extends string> = { key: K; label: string; count?: number };

/** Filter pills (spec §3.3/§3.4): selected = white fill, the rest hairline. */
export function FilterPills<K extends string>({
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
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={clsx(
              'rounded-pill border px-3 py-1 text-body-sm transition-colors',
              on
                ? 'border-accent bg-accent text-on-accent'
                : 'border-hairline bg-canvas text-ink hover:border-ghost',
            )}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className={on ? 'text-on-accent/70' : 'text-mute'}> · {o.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
