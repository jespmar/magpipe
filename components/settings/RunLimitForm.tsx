'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/arc/input/input';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { maxRunsInput, MAX_RUNS_LIMIT, type Settings } from '@/lib/schemas';

type Props = {
  /** The limit now in force. */
  maxRuns: number;
  /** When set, the form is unavailable and this says why. */
  disabledReason?: string;
};

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * How many runs work at the same time (D41), saved through PATCH /api/settings; the engine takes
 * the new limit at once. The software factory builds that many goals side by side.
 */
export function RunLimitForm({ maxRuns, disabledReason }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(String(maxRuns));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | undefined>();

  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed = maxRunsInput.safeParse(value.trim() === '' ? Number.NaN : Number(value));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a whole number of runs, for example 2');
      return;
    }
    setStatus('saving');
    setError(undefined);
    try {
      const { settings } = await api<{ settings: Settings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ maxRuns: parsed.data }),
      });
      setValue(String(settings.maxRuns));
      setStatus('saved');
      router.refresh();
    } catch (err) {
      setStatus('idle');
      setError(
        err instanceof ApiError
          ? err.message
          : 'The limit was not saved. Check Magpipe is running and try again.',
      );
    }
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-3">
      <div className="max-w-[16rem]">
        <Input
          label="Runs at once"
          description={
            disabledReason ??
            `1 to ${MAX_RUNS_LIMIT}. More finish sooner and spend faster; the factory builds this many goals side by side.`
          }
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={value}
          error={error}
          disabled={Boolean(disabledReason)}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus('idle');
            setError(undefined);
          }}
          style={MONO}
        />
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status === 'saved' ? `Saved. ${value} runs may work at once.` : ''}
      </p>
      <div>
        <Button
          type="submit"
          size="sm"
          loading={status === 'saving'}
          disabled={Boolean(disabledReason)}
        >
          {status === 'saved' ? 'Saved' : 'Save limit'}
        </Button>
      </div>
    </form>
  );
}
