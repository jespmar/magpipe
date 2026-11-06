import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';
import { Button } from '@/components/ui/Button';
import { SeedCount } from '@/components/ui/SeedCount';
import { safeCount } from '@/lib/counts';

export const metadata: Metadata = { title: 'Tools' };

export default async function ToolsPage() {
  const count = await safeCount('tools');
  return (
    <>
      <PageHead
        eyebrow="Beaks & claws"
        title="Tools"
        description="MCP servers and integrations the flock can use. Each tool is scoped per bird — nothing is reachable unless it is granted here."
        actions={
          <Button variant="primary" disabled>
            + Connect tool
          </Button>
        }
      />
      <Placeholder pr={3} spec="§3.5" artboards="Tools · ToolsWide">
        <SeedCount count={count} noun="tools" />
      </Placeholder>
    </>
  );
}
