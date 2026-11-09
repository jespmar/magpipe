/** "Researcher, Coder, Reviewer and Operator" — an English list with no Oxford comma. */
export function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
