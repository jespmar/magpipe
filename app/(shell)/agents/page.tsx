import type { Metadata } from 'next';
import { AgentsScreen } from '@/components/agents/AgentsScreen';
import { PageHead } from '@/components/ui/PageHead';
import { UnavailableState } from '@/components/ui/EmptyState';
import { listAgents, listNamespaceOptions, listToolOptions } from '@/lib/agents';
import { getDb } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { modelOptions } from '@/lib/models';

export const metadata: Metadata = { title: 'Agents' };

type Props = { searchParams: Promise<{ new?: string; agent?: string }> };

export default async function AgentsPage({ searchParams }: Props) {
  const params = await searchParams;
  try {
    const db = await getDb();
    const [agents, tools, namespaces, [row]] = await Promise.all([
      listAgents(db),
      listToolOptions(db),
      listNamespaceOptions(db),
      db.select({ models: settings.models }).from(settings).limit(1),
    ]);
    const defaultModel = row?.models.default ?? 'claude-sonnet-5-5';
    return (
      <AgentsScreen
        agents={agents}
        tools={tools}
        namespaces={namespaces}
        models={modelOptions([defaultModel, ...agents.map((a) => a.model)])}
        defaultModel={defaultModel}
        initialSlug={params.agent}
        openNew={params.new === '1'}
      />
    );
  } catch (err) {
    console.error('[agents] unavailable:', err);
    return (
      <>
        <PageHead
          title="Agents"
          description="Every bird Magpipe can send out: what it does, what it may touch, and how it has been flying."
        />
        <UnavailableState />
      </>
    );
  }
}
