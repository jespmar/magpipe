import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { DemoLink } from '@/components/ui/DemoLink';
import { plural } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Tools' };

export default async function ToolsPage() {
  const ov = await getOverview();

  const head = (
    <PageHead
      eyebrow="Beaks & claws"
      title="Tools"
      description="MCP servers and integrations the flock can use. Each tool is scoped per bird — nothing is reachable unless it is granted here."
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

  const n = ov.tools.count;
  const needsAuth = ov.tools.needsAuth;
  const facts =
    n > 0
      ? [
          plural(n, 'tool'),
          needsAuth > 0
            ? `${needsAuth} ${needsAuth === 1 ? 'needs' : 'need'} re-authorising`
            : 'all connected',
        ]
      : undefined;

  return (
    <>
      {head}
      <EmptyState
        title={n > 0 ? `${plural(n, 'tool')} in the kit` : 'No tools connected yet'}
        facts={facts}
        actions={ov.fresh ? <DemoLink /> : undefined}
      >
        <p>
          Birds reach the world through tools: MCP servers you connect here, plus the built-ins (web
          search, file reading, a sandboxed workspace). Tool cards — what each bird may reach, call
          counts, re-authorising — and connecting new servers land here next
          {ov.fresh ? '; the demo data adds nine example tools to look at now' : ''}.
        </p>
      </EmptyState>
    </>
  );
}
