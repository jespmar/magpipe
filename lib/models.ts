/** Model ids offered in the agent editor. The API ids, not the marketing names (D9). */
export const KNOWN_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

/** Known models first, then anything already in use that is not on the list. */
export function modelOptions(inUse: readonly string[]): string[] {
  const extra = inUse.filter((m) => !(KNOWN_MODELS as readonly string[]).includes(m));
  return [...KNOWN_MODELS, ...Array.from(new Set(extra)).sort()];
}
