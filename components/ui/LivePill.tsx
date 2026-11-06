export function LivePill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-pill border border-hairline px-3 py-1 text-body-sm text-ink">
      <span
        aria-hidden
        className={`size-2 rounded-pill bg-accent ${count > 0 ? 'animate-blink' : 'opacity-40'}`}
      />
      {count} active
    </span>
  );
}
