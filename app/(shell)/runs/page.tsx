import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';
import { ButtonLink } from '@/components/ui/Button';
import { SeedCount } from '@/components/ui/SeedCount';
import { safeCount } from '@/lib/counts';

export const metadata: Metadata = { title: 'Runs' };

export default async function RunsPage() {
  const count = await safeCount('runs');
  return (
    <>
      <PageHead
        eyebrow="Flights"
        title="Runs"
        description="Every task Magpipe has sent the flock out on — who flew, how long it took, what it cost."
        actions={
          <ButtonLink href="/" variant="primary">
            New run
          </ButtonLink>
        }
      />
      <Placeholder pr={7} spec="§3.4" artboards="Runs · RunsWide">
        <SeedCount count={count} noun="runs" />
      </Placeholder>
    </>
  );
}
