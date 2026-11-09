/**
 * Route-transition skeleton in the shape of a page head, not a spinner. Each list segment has a
 * `loading.tsx` that re-exports this; the run detail route deliberately has none, because a
 * streaming boundary above a page that calls `notFound()` would answer 200 before the 404.
 */
export function PageSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-3 motion-safe:animate-pulse">
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="h-5 w-28 rounded-xs bg-canvas-soft" />
      <div aria-hidden className="h-10 w-64 max-w-full rounded-xs bg-canvas-soft" />
      <div aria-hidden className="h-5 w-[31rem] max-w-full rounded-xs bg-canvas-soft" />
    </div>
  );
}
