import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { plural } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Tools' };

export default async function ToolsPage() {
  const ov = await getOverview();
  const n = ov?.tools.count ?? 0;
  const needsAuth = ov?.tools.needsAuth ?? 0;

  return (
    <>
      <PageHead
        eyebrow="Beaks & claws"
        title="Tools"
        description="MCP servers and integrations the flock can use. Each tool is scoped per bird — nothing is reachable unless it is granted here."
      />
      <EmptyState
        title={n > 0 ? `${plural(n, 'tool')} in the kit` : 'No tools connected yet'}
        facts={
          ov
            ? [
                plural(n, 'tool'),
                needsAuth > 0
                  ? `${needsAuth} ${needsAuth === 1 ? 'needs' : 'need'} re-authorising`
                  : 'all connected',
              ]
            : undefined
        }
      >
        <p>
          Birds reach the world through tools: MCP servers you connect here, plus the built-ins (web
          search, file reading, a sandboxed workspace). Tool cards — what each bird may reach, call
          counts, re-authorising — and connecting new servers land here next.
        </p>
      </EmptyState>
    </>
  );
}
