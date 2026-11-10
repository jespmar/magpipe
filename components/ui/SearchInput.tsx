'use client';

import { clsx } from 'clsx';
import { SearchField } from '@/components/arc/search-field/search-field';

/**
 * Arc's search field with its label kept for assistive tech only: in a toolbar the magnifier
 * and the placeholder already say what the field is.
 */
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
  return (
    <div className={clsx('w-[240px] max-w-full [&_label]:sr-only', className)}>
      <SearchField
        label={label}
        placeholder={placeholder ?? label}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
}
