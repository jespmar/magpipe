import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';
import { Button } from '@/components/ui/Button';
import { SeedCount } from '@/components/ui/SeedCount';
import { safeCount } from '@/lib/counts';

export const metadata: Metadata = { title: 'Agents' };

export default async function AgentsPage() {
  const count = await safeCount('agents');
  return (
    <>
      <PageHead
        eyebrow="The flock"
        title="Agents"
        description="Every bird Magpipe can send out — what it does, what it may touch, and how it has been flying."
        actions={
          <Button variant="primary" disabled>
            + Add a bird
          </Button>
        }
      />
      <Placeholder pr={2} spec="§3.3" artboards="Agents · AgentsWide">
        <SeedCount count={count} noun="agents" />
      </Placeholder>
    </>
  );
}
