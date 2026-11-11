import type { Metadata } from 'next';
import { Factory } from 'lucide-react';
import { AutoRefresh } from '@/components/factory/AutoRefresh';
import { FactoryBoard } from '@/components/factory/FactoryBoard';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState, UnavailableState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';
import { getDb } from '@/lib/db';
import { getBoard, type Board } from '@/lib/factory-board';
import { missingAgents } from '@/lib/factory';
import { clockTime } from '@/lib/home-util';

export const metadata: Metadata = { title: 'Factory' };

const DESCRIPTION =
  'Every spec and goal the factory owns, by stage. Approve a spec and answer the question to merge here, or in Linear.';

/**
 * The factory screen (D43): the pipeline at a glance, both gates in reach. It reads what Magpipe
 * stored from Linear and the runs; the watcher keeps that current, and the page re-reads it while
 * it is open.
 */
export default async function FactoryPage() {
  let board: Board;
  let loaded = false;
  try {
    const db = await getDb();
    board = await getBoard(db);
    loaded = (await missingAgents(db, 'spec')).length === 0;
  } catch (err) {
    console.error('[factory] unavailable:', err);
    return (
      <>
        <PageHead title="Factory" />
        <UnavailableState />
      </>
    );
  }

  const meta = [
    board.lastCheckAt ? `last check ${clockTime(board.lastCheckAt)}` : 'not checked yet',
    `${board.counts.specs} ${board.counts.specs === 1 ? 'spec' : 'specs'}`,
    `${board.counts.goals} ${board.counts.goals === 1 ? 'goal' : 'goals'}`,
    `${board.counts.building} building`,
    `${board.counts.landing} merging`,
    board.github ? 'pull requests on' : 'pull requests off',
  ];
  const head = (
    <PageHead
      title="Factory"
      description={DESCRIPTION}
      meta={meta.map((m) => (
        <span key={m}>{m}</span>
      ))}
      actions={
        <ButtonLink href="/settings#linear" size="sm">
          Linear and GitHub
        </ButtonLink>
      }
    />
  );

  if (!board.linear || board.counts.specs + board.counts.goals === 0) {
    return (
      <div className="flex flex-col gap-8">
        {head}
        <EmptyState
          icon={<Factory size={24} strokeWidth={1.75} />}
          label="Factory"
          title={board.linear ? 'No specs in the factory yet' : 'The factory has no Linear yet'}
          description={
            board.linear
              ? 'Send an idea to the factory from Home. A spec that passes review lands here as an issue waiting for your approval, then its goals build and wait for your answer to merge.'
              : 'Specs land in Linear once the factory has a key, a team and the six statuses. Until then, Send to the factory on Home still writes and reviews specs.'
          }
          facts={[
            loaded ? 'factory agents loaded' : 'factory agents not loaded',
            board.linear ? 'Linear set up' : 'Linear not set up',
            board.github ? 'GitHub set up' : 'GitHub not set up',
          ]}
          actions={
            <div className="flex flex-wrap justify-center gap-3">
              <ButtonLink href="/" size="sm">
                Go to Home
              </ButtonLink>
              <ButtonLink
                href={board.linear ? '/settings#github' : '/settings#linear'}
                size="sm"
                variant="ghost"
              >
                {board.linear ? 'Set up GitHub' : 'Set up Linear'}
              </ButtonLink>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {head}
      {board.lastError ? (
        <p role="status" className="text-body-sm text-danger">
          The last check said: {board.lastError}
        </p>
      ) : null}
      <FactoryBoard board={board} />
      <AutoRefresh />
    </div>
  );
}
