'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ButtonLink } from '@/components/ui/Button';
import { runStatusVariant, StatusPill } from '@/components/ui/StatusPill';
import type { LatestFlight } from '@/lib/home';
import {
  clockTime,
  LIVE_RUN_STATUSES,
  mergeEvents,
  toFlightEvent,
  type FlightEvent,
} from '@/lib/home-util';
import type { RunStatus } from '@/lib/schemas';
import { useRunEvents } from '@/lib/use-run-events';

type Props = {
  latest: LatestFlight | null;
  agentNames: Record<string, string>;
  className?: string;
};

/** How often the rest of the screen re-reads the server while events stream in. */
const REFRESH_EVERY_MS = 2500;

/**
 * The flight log (spec §3.2 zone 3): the latest run's trail, `time · agent · text`, streaming
 * while the run is live. Mounted at every width (it also drives the screen's live refresh) and
 * shown only where there is room for it, from 1600 px.
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
  const lastRefresh = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRefresh() {
    const wait = lastRefresh.current + REFRESH_EVERY_MS - Date.now();
    if (wait <= 0) {
      lastRefresh.current = Date.now();
      router.refresh();
    } else if (!pending.current) {
      pending.current = setTimeout(() => {
        pending.current = null;
        lastRefresh.current = Date.now();
        router.refresh();
      }, wait);
    }
  }
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

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
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Activity</span>
          <h2 id="flight-log-title" className="page-title">
            Flight log
          </h2>
        </div>
        <ButtonLink href="/runs" variant="ghost">
          All flights
        </ButtonLink>
      </div>
      <div className="flex min-w-0 flex-col rounded-md border border-hairline bg-(image:--g-card) p-5">
        {latest ? (
          <>
            <div className="mb-1 flex items-center justify-between gap-4 border-b border-hairline pb-3">
              <span className="truncate font-mono text-code text-code-ink">
                {latest.run.displayId} · {latest.run.title}
              </span>
              {live ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-caption font-medium text-ink-strong">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-pill bg-accent motion-safe:animate-blink"
                  />
                  streaming
                </span>
              ) : (
                <StatusPill variant={runStatusVariant(status!)} />
              )}
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
                  <li
                    key={e.seq}
                    className="flex items-start gap-4 border-b border-hairline-soft py-2.5 last:border-b-0"
                  >
                    <time
                      dateTime={e.ts}
                      className="w-16 shrink-0 font-mono text-code text-mute tabular-nums"
                    >
                      {clockTime(new Date(e.ts))}
                    </time>
                    <span
                      className={clsx(
                        'w-24 shrink-0 truncate font-mono text-code font-[550]',
                        e.agentId === null ? 'text-cyan' : 'text-ink-strong',
                      )}
                    >
                      {e.agent}
                    </span>
                    <span
                      className={clsx(
                        'min-w-0 flex-1 text-body-sm [overflow-wrap:anywhere]',
                        e.kind === 'error' ? 'text-danger' : 'text-body',
                      )}
                    >
                      {e.text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <p className="max-w-[31rem] py-2 text-body-sm text-body">
            No flights yet. The first task you run leaves its trail here — each step, which bird
            flew it, what it brought back — as it happens.
          </p>
        )}
      </div>
    </section>
  );
}
