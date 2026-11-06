import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';
import { Button } from '@/components/ui/Button';
import { SeedCount } from '@/components/ui/SeedCount';
import { safeCount } from '@/lib/counts';

export const metadata: Metadata = { title: 'Memory' };

export default async function MemoryPage() {
  const count = await safeCount('memory');
  return (
    <>
      <PageHead
        eyebrow="The nest"
        title="Memory"
        description="The shiny bits the flock brings back — durable facts, decisions and limits every bird reads before it flies."
        actions={
          <Button variant="primary" disabled>
            + Add fact
          </Button>
        }
      />
      <Placeholder pr={4} spec="§3.6" artboards="Memory · MemoryWide">
        <SeedCount count={count} noun="memory entries" />
      </Placeholder>
    </>
  );
}
