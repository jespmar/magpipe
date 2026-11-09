import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { getDb } from '@/lib/db';
import { runs } from '@/lib/db/schema';
import { formatDuration, formatTokens, relativeTime } from '@/lib/format';
import type { Run } from '@/lib/schemas';
import { runStatusLabel } from '@/lib/text';

type Props = { params: Promise<{ id: string }> };

/** `undefined` = no such flight; `null` = the database is unavailable. */
async function loadRun(displayId: string): Promise<Run | null | undefined> {
  try {
    const [run] = await (await getDb()).select().from(runs).where(eq(runs.displayId, displayId));
    return run;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const run = await loadRun(id);
  return { title: run ? `${run.input.text} · ${id}` : id };
}

export default async function RunDetailPage({ params }: Props) {
  const { id } = await params;
  const run = await loadRun(id);
  if (run === undefined) notFound();

  if (run === null) {
    return (
      <>
        <PageHead eyebrow="Flight" title={id} />
        <EmptyState title="This flight can’t be read right now">
          <p>The database is unavailable — see the notice at the top of the page.</p>
        </EmptyState>
      </>
    );
  }

  const meta = [
    run.displayId,
    runStatusLabel(run.status),
    run.durationMs !== null ? formatDuration(run.durationMs) : null,
    `${formatTokens(run.usage.inputTokens + run.usage.outputTokens)} tokens`,
    run.startedAt ? `started ${relativeTime(run.startedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHead eyebrow="Flight" title={run.input.text} meta={meta} />
      <EmptyState
        title="Flight path and log land here"
        facts={[`${run.plan.length} steps`, `${run.plan.filter((s) => s.agentId).length} birds`]}
      >
        <p>
          Each step this flight took — which bird, what it did, with which tool, how many tokens —
          with the live log beside it and the merged output and any files below.
        </p>
      </EmptyState>
    </>
  );
}
