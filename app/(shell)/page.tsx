import { PageHead } from '@/components/ui/PageHead';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { plural, relativeTime } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export default async function HomePage() {
  const ov = await getOverview();
  const fresh = ov !== null && ov.tools.count === 0 && ov.runs.count === 0;

  const facts = ov
    ? [
        plural(ov.agents.count, 'bird') + ' in the flock',
        ov.runs.latest
          ? `${plural(ov.runs.count, 'flight')} flown · last ${relativeTime(ov.runs.latest.at)}`
          : 'no flights yet',
        plural(ov.memory.count, 'shiny bit') + ' in the nest',
      ]
    : undefined;

  return (
    <>
      <PageHead
        eyebrow="The flock"
        title="Birds on the wire"
        description="Hand Magpipe a task. It picks the birds, splits the work, flies it, and reports back."
      />
      <EmptyState
        title="Ask Magpipe is on its way"
        facts={facts}
        actions={
          <>
            <ButtonLink href="/agents" variant="outline">
              Meet the flock
            </ButtonLink>
            {fresh ? (
              <ButtonLink href="/settings" variant="ghost">
                Load demo data
              </ButtonLink>
            ) : null}
          </>
        }
      >
        <p>
          The prompt where you describe a task and attach files will sit here, with your birds on
          duty above it and the live flight log beside it. Until then, your flock is set up and
          ready to meet{fresh ? ', and the demo data shows what a finished flight looks like' : ''}.
        </p>
      </EmptyState>
    </>
  );
}
