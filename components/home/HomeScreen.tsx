'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { RunMiniCards } from './HomeCards';
import { PromptComposer } from './PromptComposer';
import { RunPanel } from './RunPanel';
import { api, ApiError } from '@/lib/client-api';
import { defaultSelected, LIVE_RUN_STATUSES, reviveRun, type FlightEvent } from '@/lib/home-util';
import { threadFor } from '@/lib/runs-util';
import type { Run } from '@/lib/schemas';
import { useLiveRefresh } from '@/lib/use-run-events';

type Props = {
  /** The newest flights first, their cards not closed. */
  runs: Run[];
  agentNames: Record<string, string>;
  /** The server's first choice (the live run, else the newest) and its trail so far. */
  initialSelectedId: string | null;
  initialEvents: FlightEvent[];
  now: Date;
  /** The nest, rendered by the server. */
  core: ReactNode;
  /** The software factory's spec template can run (D37). */
  factory?: boolean;
};

/**
 * Home as a conversation (D23): the cards on the left choose a flight, the panel on the right
 * shows it, and the prompt underneath continues it. A flight started here is selected in place;
 * Home never leaves for the run's page. Closing a card hides it here only.
 */
export function HomeScreen({
  runs,
  agentNames,
  initialSelectedId,
  initialEvents,
  now,
  core,
  factory = false,
}: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  // Whether the prompt continues the selected flight; "New question" turns it off until the
  // next choice.
  const [following, setFollowing] = useState(true);
  // Flights started here, shown until the server lists them.
  const [started, setStarted] = useState<Run[]>([]);
  // Cards closed here, hidden at once; the server stops listing them on the next refresh.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const visible = useMemo(() => {
    const fresh = started.filter((s) => !runs.some((r) => r.id === s.id));
    return [...fresh, ...runs].filter((r) => !hidden.has(r.id));
  }, [runs, started, hidden]);
  const selected = visible.find((r) => r.id === selectedId) ?? defaultSelected(visible);
  const thread = useMemo(() => (selected ? threadFor(visible, selected) : []), [visible, selected]);

  // The selected flight's log keeps the screen current; a live flight that is not being read
  // still has to move its card and the counters.
  const otherLive =
    visible.find((r) => LIVE_RUN_STATUSES.has(r.status) && r.id !== selected?.id) ?? null;
  useLiveRefresh(otherLive?.id ?? null, otherLive !== null);

  function select(run: Run) {
    setSelectedId(run.id);
    setFollowing(true);
  }

  function onStarted(run: Run) {
    const revived = reviveRun(run);
    setStarted((prev) => [revived, ...prev.filter((r) => r.id !== revived.id)]);
    select(revived);
    router.refresh();
  }

  async function close(run: Run) {
    setNotice(null);
    setHidden((prev) => new Set(prev).add(run.id));
    try {
      await api(`/api/runs/${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ dismissed: true }),
      });
      router.refresh();
    } catch (err) {
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
      setNotice(
        err instanceof ApiError ? err.message : `${run.displayId} could not be closed. Try again.`,
      );
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-10">
      <div className="grid gap-10 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)] md:items-start md:gap-x-8 wide:gap-x-12">
        <RunMiniCards
          runs={visible}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onClose={close}
          notice={notice}
          now={now}
          className="order-2 md:order-1"
        />
        <div className="order-1 flex min-w-0 md:order-2">{core}</div>
        {selected ? (
          <RunPanel
            key={selected.id}
            run={selected}
            thread={thread}
            initialEvents={selected.id === initialSelectedId ? initialEvents : []}
            agentNames={agentNames}
            onSelect={select}
            onRefly={onStarted}
            className="order-3"
          />
        ) : (
          <div aria-hidden className="hidden md:order-3 md:block" />
        )}
      </div>
      {/* Pinned to the bottom of the screen: the one thing Home is for stays within reach. */}
      <div className="z-10 mt-auto bg-canvas pt-4 pb-2 md:sticky md:bottom-0">
        <PromptComposer
          target={following ? selected : null}
          onClearTarget={() => setFollowing(false)}
          onStarted={onStarted}
          factory={factory}
        />
      </div>
    </div>
  );
}
