'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';
import type { RunEventLike } from './home-util';
import type { RunStatus } from './schemas';

type Options = {
  runId: string | null;
  /** Connect only while the run can still produce events. */
  enabled: boolean;
  /** The last sequence number already shown; the stream resumes after it. */
  afterSeq: number;
  onEvent: (event: RunEventLike) => void;
  /** The server's `end` frame: the run is over and its trail is complete. */
  onEnd: (status: RunStatus) => void;
};

/**
 * Tails `GET /api/runs/[id]/events` (spec §8) with EventSource, which reconnects on its own and
 * resumes from `Last-Event-ID`. Callbacks are read through refs so a re-render never reconnects.
 */
export function useRunEvents({ runId, enabled, afterSeq, onEvent, onEnd }: Options) {
  const onEventRef = useRef(onEvent);
  const onEndRef = useRef(onEnd);
  const afterRef = useRef(afterSeq);
  onEventRef.current = onEvent;
  onEndRef.current = onEnd;
  afterRef.current = afterSeq;

  useEffect(() => {
    if (!enabled || !runId) return;
    const source = new EventSource(`/api/runs/${runId}/events?after=${afterRef.current}`);
    source.addEventListener('run_event', (e) => {
      onEventRef.current(JSON.parse((e as MessageEvent<string>).data) as RunEventLike);
    });
    source.addEventListener('end', (e) => {
      source.close();
      const { status } = JSON.parse((e as MessageEvent<string>).data) as { status: RunStatus };
      onEndRef.current(status);
    });
    return () => source.close();
  }, [runId, enabled]);
}

/** How often a screen re-reads the server while a run's events stream in. */
export const REFRESH_EVERY_MS = 2500;

/**
 * `router.refresh()` at most once per `everyMs`; a call inside the window lands once it closes,
 * so the last event is never missed.
 */
export function useThrottledRefresh(everyMs = REFRESH_EVERY_MS): () => void {
  const router = useRouter();
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  return useCallback(() => {
    const wait = last.current + everyMs - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      router.refresh();
    } else if (!pending.current) {
      pending.current = setTimeout(() => {
        pending.current = null;
        last.current = Date.now();
        router.refresh();
      }, wait);
    }
  }, [router, everyMs]);
}

/**
 * Keeps a screen that shows a run's state (but not its trail) current while the run is live:
 * every event schedules a throttled refresh, the end frame refreshes once more.
 */
export function useLiveRefresh(runId: string | null, live: boolean) {
  const router = useRouter();
  const schedule = useThrottledRefresh();
  useRunEvents({
    runId,
    enabled: live,
    afterSeq: 0,
    onEvent: schedule,
    onEnd: () => router.refresh(),
  });
}
