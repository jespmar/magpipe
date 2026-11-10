'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from './Button';

/** Re-renders the current route (server data included): the recovery step for the DB notice. */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {label}
    </Button>
  );
}
