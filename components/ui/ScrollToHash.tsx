'use client';

import { useEffect } from 'react';

/**
 * Client-side navigations to `/settings#demo` do not scroll (the route's loading boundary
 * renders first and the hash is lost). Scroll the target into view and move focus to its
 * heading once the page has mounted; hard loads already do this natively.
 */
export function ScrollToHash() {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    const heading = target.querySelector<HTMLElement>('h1, h2, h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, []);
  return null;
}
