import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { listSentence } from '@/lib/text';
import { getOverview } from '@/lib/overview';

export const metadata: Metadata = { title: 'Agents' };

export default async function AgentsPage() {
  const ov = await getOverview();

  const head = (
    <PageHead
      eyebrow="The flock"
      title="Agents"
      description="Every bird Magpipe can send out — what it does, what it may touch, and how it has been flying."
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

  const names = ov.agents.names;
  return (
    <>
      {head}
      <EmptyState
        title={names.length > 0 ? 'Your flock is set up' : 'No birds in the flock'}
        facts={names}
      >
        <p>
          {names.length > 0
            ? `${listSentence(names)} ${names.length === 1 ? 'has' : 'have'} ${
                names.length === 1 ? 'its' : 'their'
              } roles and prompts ready. `
            : 'Birds are the agents Magpipe sends out. '}
          Each bird’s card — its tools, the memory it may read and write, and how it has been flying
          — lands here next, along with adding birds of your own.
        </p>
      </EmptyState>
    </>
  );
}
