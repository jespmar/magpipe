import type { Metadata } from 'next';
import { MemoryScreen } from '@/components/memory/MemoryScreen';
import { PageHead } from '@/components/ui/PageHead';
import { UnavailableState } from '@/components/ui/EmptyState';
import { getDb } from '@/lib/db';
import { listAuthorChips, listMemory, listNamespaces } from '@/lib/memory';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Memory' };

type Props = { searchParams: Promise<{ ns?: string; id?: string; new?: string }> };

const DESCRIPTION =
  'The shiny bits the flock brings back — durable facts, decisions and limits every bird reads before it flies.';

export default async function MemoryPage({ searchParams }: Props) {
  const params = await searchParams;
  try {
    const db = await getDb();
    const [entries, namespaces, agents, overview] = await Promise.all([
      listMemory(db),
      listNamespaces(db),
      listAuthorChips(db),
      getOverview(),
    ]);
    return (
      <MemoryScreen
        entries={entries}
        namespaces={namespaces}
        agents={agents}
        initialNs={params.ns}
        initialId={params.id}
        openNew={params.new === '1'}
        fresh={overview?.fresh ?? false}
      />
    );
  } catch (err) {
    console.error('[memory] unavailable:', err);
    return (
      <>
        <PageHead eyebrow="The nest" title="Memory" description={DESCRIPTION} />
        <UnavailableState />
      </>
    );
  }
}
