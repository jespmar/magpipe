import { useId } from 'react';
import { clsx } from 'clsx';

export function SearchInput({
  label,
  placeholder,
  value,
  onChange,
  className,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder ?? label}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          'w-[220px] max-w-full rounded-sm border border-hairline bg-canvas-soft px-4 py-2.5 text-body-sm text-ink focus:border-ink-strong focus:outline-none [&::-webkit-search-cancel-button]:appearance-none',
          className,
        )}
      />
    </>
  );
}
