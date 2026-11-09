import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { DemoLink } from '@/components/ui/DemoLink';
import { plural, relativeTime } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Runs' };

export default async function RunsPage() {
  const ov = await getOverview();

  const head = (
    <PageHead
      eyebrow="Flights"
      title="Runs"
      description="Every task Magpipe has sent the flock out on — who flew, how long it took, what it cost."
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

  const latest = ov.runs.latest;
  return (
    <>
      {head}
      {latest ? (
        <EmptyState
          title={`${plural(ov.runs.count, 'flight')} on record`}
          facts={[plural(ov.runs.count, 'run'), `latest ${latest.status}`, relativeTime(latest.at)]}
          actions={
            <ButtonLink href={`/runs/${latest.displayId}`} variant="outline">
              Open the latest flight
            </ButtonLink>
          }
        >
          <p>
            The flight table and each flight’s step-by-step path land here next. The latest flight
            was “{latest.text}” — it {latest.status === 'done' ? 'finished' : latest.status}{' '}
            {relativeTime(latest.at)}.
          </p>
        </EmptyState>
      ) : (
        <EmptyState title="No flights yet" actions={ov.fresh ? <DemoLink /> : undefined}>
          <p>
            A flight is one task handed to Magpipe, from plan to merged result. Flights appear here
            as soon as the prompt on the home screen is ready
            {ov.fresh ? '; the demo data adds a few finished ones to look at now' : ''}.
          </p>
        </EmptyState>
      )}
    </>
  );
}
