import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import { getDb } from '@/lib/db';
import { runs } from '@/lib/db/schema';
import { formatDuration, formatTokens, plural, relativeTime } from '@/lib/format';
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

/**
 * No `loading.tsx` wraps this route on purpose: a streaming boundary above a page that calls
 * `notFound()` would send a 200 before the 404 is known.
 */
export default async function RunDetailPage({ params }: Props) {
  const { id } = await params;
  const run = await loadRun(id);
  if (run === undefined) notFound();

  if (run === null) {
    return (
      <>
        <PageHead eyebrow="Flight" title={id} />
        <UnavailableState />
      </>
    );
  }

  const birds = run.plan.filter((s) => s.agentId).length;
  return (
    <>
      <PageHead
        eyebrow="Flight"
        title={run.input.text}
        meta={
          <>
            <StatusPill variant={runStatusVariant(run.status)} label={runStatusLabel(run.status)} />
            <span>{run.displayId}</span>
            {run.durationMs !== null ? <span>took {formatDuration(run.durationMs)}</span> : null}
            <span>{formatTokens(run.usage.inputTokens + run.usage.outputTokens)} tokens</span>
            {run.startedAt ? <span>started {relativeTime(run.startedAt)}</span> : null}
          </>
        }
      />
      <EmptyState
        title="Flight path and log land here"
        facts={[plural(run.plan.length, 'step'), plural(birds, 'bird')]}
      >
        <p>
          Each step this flight took — which bird, what it did, with which tool, how many tokens —
          with the live log beside it and the merged output and any files below.
        </p>
      </EmptyState>
    </>
  );
}
