import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { DemoLink } from '@/components/ui/DemoLink';
import { plural, relativeTime } from '@/lib/format';
import { getOverview } from '@/lib/overview';

export default async function HomePage() {
  const ov = await getOverview();

  const head = (
    <PageHead
      eyebrow="The flock"
      title="Birds on the wire"
      description="Hand Magpipe a task. It picks the birds, splits the work, flies it, and reports back."
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

  // Fact lines use the precise nouns; the metaphor stays in headings and prose.
  const facts = [
    plural(ov.agents.count, 'agent'),
    ov.runs.latest ? plural(ov.runs.count, 'run') : 'no runs yet',
    ov.runs.latest ? `last run ${relativeTime(ov.runs.latest.at)}` : null,
    plural(ov.memory.count, 'memory', 'memories'),
  ].filter((f): f is string => f !== null);

  return (
    <>
      {head}
      <EmptyState
        title="Ask Magpipe is on its way"
        facts={facts}
        actions={
          <>
            <ButtonLink href="/agents" variant="outline">
              Meet the flock
            </ButtonLink>
            {ov.fresh ? <DemoLink /> : null}
          </>
        }
      >
        <p>
          The prompt where you describe a task and attach files will sit here, with your birds on
          duty above it and the live flight log beside it. Until then, your flock is set up and
          ready to meet
          {ov.fresh ? ', and the demo data shows what a finished flight looks like' : ''}.
        </p>
      </EmptyState>
    </>
  );
}
