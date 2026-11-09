'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from './Button';

/** Re-renders the current route (server data included) — the recovery step for the DB banner. */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? 'Trying again…' : label}
    </Button>
  );
}
