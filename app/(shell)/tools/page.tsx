import type { Metadata } from 'next';
import { ToolsScreen } from '@/components/tools/ToolsScreen';
import { PageHead } from '@/components/ui/PageHead';
import { UnavailableState } from '@/components/ui/EmptyState';
import { getDb } from '@/lib/db';
import { getOverview } from '@/lib/overview';
import { secretsReady } from '@/lib/secrets';
import { listAgentChips, listTools } from '@/lib/tools';

export const metadata: Metadata = { title: 'Tools' };

type Props = { searchParams: Promise<{ connect?: string }> };

const DESCRIPTION =
  'MCP servers and integrations the flock can use. Each tool is scoped per bird — nothing is reachable unless it is granted here.';

export default async function ToolsPage({ searchParams }: Props) {
  const params = await searchParams;
  try {
    const db = await getDb();
    const [tools, agents, overview] = await Promise.all([
      listTools(db),
      listAgentChips(db),
      getOverview(),
    ]);
    return (
      <ToolsScreen
        tools={tools}
        agents={agents}
        openConnect={params.connect === '1'}
        fresh={overview?.fresh ?? false}
        secretsReady={secretsReady()}
      />
    );
  } catch (err) {
    console.error('[tools] unavailable:', err);
    return (
      <>
        <PageHead eyebrow="Beaks & claws" title="Tools" description={DESCRIPTION} />
        <UnavailableState />
      </>
    );
  }
}
