'use client';

import { useEffect, useRef } from 'react';
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
