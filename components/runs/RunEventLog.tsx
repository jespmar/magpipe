'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { EventRow } from '@/components/runs/EventRow';
import { Streaming } from '@/components/home/FlightLog';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import { mergeEvents, toFlightEvent, type FlightEvent } from '@/lib/home-util';
import { LIVE } from '@/lib/runs-util';
import type { Run, RunStatus } from '@/lib/schemas';
import { useRunEvents, useThrottledRefresh } from '@/lib/use-run-events';

type Props = {
  run: Pick<Run, 'id' | 'status'>;
  initialEvents: FlightEvent[];
  agentNames: Record<string, string>;
  /** Fetch the trail from the server even when the run is over (the stream replays, then ends). */
  replay?: boolean;
  /** `plain` drops the card frame, for a log that sits inside another card. */
  frame?: 'card' | 'plain';
  className?: string;
};

/**
 * The full flight log (spec §3.4, §5.8): the server's replay merged with the live stream by
 * sequence, following the newest line unless the pointer rests on the list. Each streamed event
 * also re-reads the page's server data, so the path and the head keep up.
 */
export function RunEventLog({
  run,
  initialEvents,
  agentNames,
  replay = false,
  frame = 'card',
  className,
}: Props) {
  const router = useRouter();
  const [received, setReceived] = useState<FlightEvent[]>([]);
  const [endedAs, setEndedAs] = useState<RunStatus | null>(null);
  const status = endedAs ?? run.status;
  const live = LIVE.has(status);
  const events = useMemo(() => mergeEvents(initialEvents, received), [initialEvents, received]);
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  const scheduleRefresh = useThrottledRefresh();

  useRunEvents({
    runId: run.id,
    enabled: live || replay,
    afterSeq: lastSeq,
    // A replayed trail of a finished run changes nothing else on the page, so it must not
    // refresh the router: a refresh racing a click on "Open log" would swallow the navigation.
    onEvent: (e) => {
      setReceived((prev) => [...prev, toFlightEvent(e, agentNames)]);
      if (live) scheduleRefresh();
    },
    onEnd: (s) => {
      setEndedAs(s);
      if (live) router.refresh();
    },
  });

  const list = useRef<HTMLOListElement>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (live && !reading && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [events.length, live, reading]);

  return (
    <section
      aria-labelledby="run-log-title"
      className={clsx('flex min-w-0 flex-col gap-3', frame === 'card' && 'card p-5', className)}
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          id="run-log-title"
          className={clsx(
            'text-ink-strong',
            frame === 'card' ? 'text-display-sm' : 'text-body-sm font-medium',
          )}
        >
          Flight log
        </h2>
        {live ? <Streaming /> : <StatusPill variant={runStatusVariant(status)} />}
      </div>
      {events.length === 0 ? (
        <p className="border-t border-hairline-soft py-4 text-body-sm text-body">
          {live ? 'Waking the flock…' : 'This run left no trail.'}
        </p>
      ) : (
        <ol
          ref={list}
          role="log"
          aria-label="Run events"
          onPointerEnter={() => setReading(true)}
          onPointerLeave={() => setReading(false)}
          className={clsx(
            'overflow-y-auto border-t border-hairline-soft',
            frame === 'card' ? 'max-h-[40rem]' : 'max-h-[24rem]',
          )}
        >
          {events.map((e) => (
            <EventRow key={e.seq} event={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
