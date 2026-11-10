/** A live dot and the word: the trail is still being written. */
export function Streaming() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-ink-strong">
      <span aria-hidden className="size-1.5 rounded-pill bg-cyan motion-safe:animate-blink" />
      streaming
    </span>
  );
}
