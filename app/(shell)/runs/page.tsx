import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { plural, relativeTime } from '@/lib/format';
import { getOverview } from '@/lib/overview';
import { runStatusLabel } from '@/lib/text';

export const metadata: Metadata = { title: 'Runs' };

export default async function RunsPage() {
  const ov = await getOverview();
  const latest = ov?.runs.latest ?? null;

  return (
    <>
      <PageHead
        eyebrow="Flights"
        title="Runs"
        description="Every task Magpipe has sent the flock out on — who flew, how long it took, what it cost."
      />
      {latest ? (
        <EmptyState
          title={`${plural(ov!.runs.count, 'flight')} on record`}
          facts={[
            `latest ${latest.displayId}`,
            runStatusLabel(latest.status),
            relativeTime(latest.at),
          ]}
          actions={
            <ButtonLink href={`/runs/${latest.displayId}`} variant="outline">
              Open the latest flight
            </ButtonLink>
          }
        >
          <p>
            The flight table — which birds flew, how long each flight took, what it cost — and each
            flight’s step-by-step path land here next. Every flight already on record can be opened
            by its id.
          </p>
        </EmptyState>
      ) : (
        <EmptyState title="No flights yet">
          <p>
            A flight is one task handed to Magpipe, from plan to merged result. Flights appear here
            as soon as the prompt on the home screen is ready; until then the demo data in Settings
            adds a few finished ones to look at.
          </p>
        </EmptyState>
      )}
    </>
  );
}
