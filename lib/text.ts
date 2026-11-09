/** "Researcher, Coder, Reviewer and Operator" — an English list with no Oxford comma. */
export function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const STATUS_LABEL = {
  queued: 'queued',
  running: 'flying',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

/** Run status in the flight vocabulary used on screen. */
export function runStatusLabel(status: keyof typeof STATUS_LABEL): string {
  return STATUS_LABEL[status];
}
