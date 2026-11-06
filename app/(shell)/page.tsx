import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';
import { ButtonLink } from '@/components/ui/Button';
import { SeedCount } from '@/components/ui/SeedCount';
import { safeCount } from '@/lib/counts';

export default async function HomePage() {
  const agents = await safeCount('agents');
  return (
    <>
      <PageHead
        eyebrow="The flock"
        title="Birds on the wire"
        actions={
          <ButtonLink href="/agents?new=1" variant="ghost" className="py-2 leading-6">
            + Add a bird
          </ButtonLink>
        }
      />
      <Placeholder pr={6} spec="§3.2" artboards="Main · Wide">
        <p className="text-body-sm text-body">
          Agent cards · orchestrator orb · flight log (wide) · “Ask Magpipe” prompt composer.
        </p>
        <SeedCount count={agents} noun="agents" />
      </Placeholder>
    </>
  );
}
