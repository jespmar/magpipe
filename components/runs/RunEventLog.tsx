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
  className?: string;
};

/**
 * The full flight log (spec §3.4, §5.8): the server's replay merged with the live stream by
 * sequence, following the newest line unless the pointer rests on the list. Each streamed event
 * also re-reads the page's server data, so the path and the head keep up.
 */
export function RunEventLog({ run, initialEvents, agentNames, className }: Props) {
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
    enabled: live,
    afterSeq: lastSeq,
    onEvent: (e) => {
      setReceived((prev) => [...prev, toFlightEvent(e, agentNames)]);
      scheduleRefresh();
    },
    onEnd: (s) => {
      setEndedAs(s);
      router.refresh();
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
      className={clsx('flex min-w-0 flex-col gap-3 card p-5', className)}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="run-log-title" className="text-display-sm text-ink-strong">
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
          className="max-h-[40rem] overflow-y-auto border-t border-hairline-soft"
        >
          {events.map((e) => (
            <EventRow key={e.seq} event={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
