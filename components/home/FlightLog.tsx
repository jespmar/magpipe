'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { EventRow } from '@/components/runs/EventRow';
import { ButtonLink } from '@/components/ui/Button';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import type { LatestFlight } from '@/lib/home';
import { LIVE_RUN_STATUSES, mergeEvents, toFlightEvent, type FlightEvent } from '@/lib/home-util';
import type { RunStatus } from '@/lib/schemas';
import { useRunEvents, useThrottledRefresh } from '@/lib/use-run-events';

type Props = {
  latest: LatestFlight | null;
  agentNames: Record<string, string>;
  className?: string;
};

/**
 * The flight log (spec §3.2 zone 3, D21): the live run's trail, `time · agent · text`, streaming
 * as it happens. It also drives Home's live refresh, so the cards and counters keep up.
 */
export function FlightLog({ latest, agentNames, className }: Props) {
  const router = useRouter();
  const [received, setReceived] = useState<FlightEvent[]>([]);
  const [endedAs, setEndedAs] = useState<RunStatus | null>(null);
  const status = endedAs ?? latest?.run.status ?? null;
  const live = status !== null && LIVE_RUN_STATUSES.has(status);
  const events = useMemo(
    () => mergeEvents(latest?.events ?? [], received),
    [latest?.events, received],
  );
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

  // Cards and counters re-read the server at most every few seconds while the trail streams.
  const scheduleRefresh = useThrottledRefresh();

  useRunEvents({
    runId: latest?.run.id ?? null,
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

  // Follow the stream unless the operator is reading (pointer over the log).
  const list = useRef<HTMLOListElement>(null);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (live && !reading && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [events.length, live, reading]);

  return (
    <section
      aria-labelledby="flight-log-title"
      className={clsx('min-w-0 flex-col gap-5', className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="flight-log-title" className="page-title">
          Flight log
        </h2>
        <ButtonLink href="/runs" variant="ghost">
          All flights
        </ButtonLink>
      </div>
      <div className="flex min-w-0 flex-col card p-4">
        {latest ? (
          <>
            <div className="mb-1 flex items-center justify-between gap-4 border-b border-hairline-soft pb-3">
              <span className="truncate font-mono text-code text-ink">
                {latest.run.displayId} · {latest.run.title}
              </span>
              {live ? <Streaming /> : <StatusPill variant={runStatusVariant(status!)} />}
            </div>
            {events.length === 0 ? (
              <p className="py-6 text-body-sm text-body">
                {live ? 'Waking the flock…' : 'This run left no trail.'}
              </p>
            ) : (
              <ol
                ref={list}
                role="log"
                aria-label="Run events"
                onPointerEnter={() => setReading(true)}
                onPointerLeave={() => setReading(false)}
                className="max-h-[36rem] overflow-y-auto"
              >
                {events.map((e) => (
                  <EventRow key={e.seq} event={e} />
                ))}
              </ol>
            )}
          </>
        ) : (
          <p className="max-w-[31rem] py-2 text-body-sm text-body">
            No flights yet. The first task you run leaves its trail here as it happens: each step,
            which bird flew it, what it brought back.
          </p>
        )}
      </div>
    </section>
  );
}

/** A live dot and the word: the trail is still being written. */
export function Streaming() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-ink-strong">
      <span aria-hidden className="size-1.5 rounded-pill bg-cyan motion-safe:animate-blink" />
      streaming
    </span>
  );
}
