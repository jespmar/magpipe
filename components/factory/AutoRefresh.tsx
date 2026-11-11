'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-reads the server data on an interval while the tab is visible (the factory board, D43). */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
