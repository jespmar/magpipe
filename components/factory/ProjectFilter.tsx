'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FilterControl } from '@/components/ui/FilterControl';

/** Which project the board shows (D45): all of them, or one. The address keeps the choice. */
export function ProjectFilter({
  projects,
  value,
}: {
  projects: { id: string; name: string; count: number }[];
  value: string | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(value ?? 'all');
  const total = projects.reduce((n, p) => n + p.count, 0);
  return (
    <FilterControl
      label="Project"
      value={current}
      onChange={(key) => {
        setCurrent(key);
        router.replace(key === 'all' ? '/factory' : `/factory?project=${key}`, { scroll: false });
      }}
      options={[
        { key: 'all', label: 'All projects', count: total },
        ...projects.map((p) => ({ key: p.id, label: p.name, count: p.count })),
      ]}
    />
  );
}
