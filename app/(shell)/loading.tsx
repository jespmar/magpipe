/** Route-transition skeleton in the shape of a page head, not a spinner. */
export default function Loading() {
  return (
    <div role="status" className="flex flex-col gap-3 motion-safe:animate-pulse">
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="h-5 w-28 rounded-xs bg-canvas-soft" />
      <div aria-hidden className="h-10 w-64 max-w-full rounded-xs bg-canvas-soft" />
      <div aria-hidden className="h-5 w-[36rem] max-w-full rounded-xs bg-canvas-soft" />
    </div>
  );
}
