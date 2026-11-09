import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { plural } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Memory' };

export default async function MemoryPage() {
  const ov = await getOverview();
  const n = ov?.memory.count ?? 0;

  return (
    <>
      <PageHead
        eyebrow="The nest"
        title="Memory"
        description="The shiny bits the flock brings back — durable facts, decisions and limits every bird reads before it flies."
      />
      <EmptyState
        title={n > 0 ? `The nest holds ${plural(n, 'shiny bit')}` : 'The nest is empty'}
        facts={ov ? [plural(n, 'shiny bit'), plural(ov.memory.namespaces, 'namespace')] : undefined}
      >
        <p>
          Every durable fact a bird learns is kept here with its confidence, its source and when it
          expires, so no bird reads the same page twice. Browsing the nest by namespace, and adding
          or correcting facts yourself, lands here next.
        </p>
      </EmptyState>
    </>
  );
}
