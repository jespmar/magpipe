/** Next.js calls `register` once per server start; the engine boots here (docs/decisions.md D5). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { bootEngine } = await import('./lib/engine/boot');
  await bootEngine();
}
