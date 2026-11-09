import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { DemoLink } from '@/components/ui/DemoLink';
import { plural } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Memory' };

export default async function MemoryPage() {
  const ov = await getOverview();

  const head = (
    <PageHead
      eyebrow="The nest"
      title="Memory"
      description="The shiny bits the flock brings back — durable facts, decisions and limits every bird reads before it flies."
    />
  );
  if (!ov) {
    return (
      <>
        {head}
        <UnavailableState />
      </>
    );
  }

  const n = ov.memory.count;
  return (
    <>
      {head}
      <EmptyState
        title={n > 0 ? `The nest holds ${plural(n, 'memory', 'memories')}` : 'The nest is empty'}
        facts={
          n > 0
            ? [plural(n, 'memory', 'memories'), plural(ov.memory.namespaces, 'namespace')]
            : [plural(ov.memory.namespaces, 'namespace'), 'no memories yet']
        }
        actions={ov.fresh ? <DemoLink /> : undefined}
      >
        <p>
          Every durable fact a bird learns is kept here with its confidence, its source and when it
          expires, so no bird reads the same page twice. Browsing the nest by namespace, and adding
          or correcting facts yourself, lands here next
          {ov.fresh ? '; the demo data fills it with a dozen examples' : ''}.
        </p>
      </EmptyState>
    </>
  );
}
