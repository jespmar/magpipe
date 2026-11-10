'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/arc/input/input';
import { Button } from '@/components/ui/Button';
import { api, ApiError } from '@/lib/client-api';
import { spendCapInput, type Settings } from '@/lib/schemas';

type Props = {
  /** The cap now in force, in dollars; 0 means no cap. */
  capUsd: number;
  /** When set, the form is unavailable and this says why. */
  disabledReason?: string;
};

const MONO = { fontFamily: 'var(--font-mono)' } as const;

/** "50", "$50" and "1,000.50" all read as dollars; anything else is left for the schema to refuse. */
function dollars(text: string): number {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

function capWords(text: string): string {
  const usd = dollars(text);
  return usd > 0 ? `$${usd.toFixed(2)} a day` : 'off';
}

/**
 * The daily spend cap (D32), the first setting the operator can change: one field, saved through
 * PATCH /api/settings. The button confirms in place; an error stays beside the field. The page
 * re-reads its server data afterwards, so the spend line beside it follows.
 */
export function SpendCapForm({ capUsd, disabledReason }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(capUsd.toFixed(2));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | undefined>();

  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed = spendCapInput.safeParse(dollars(value));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the cap in dollars, for example 50');
      return;
    }
    setStatus('saving');
    setError(undefined);
    try {
      const { settings } = await api<{ settings: Settings }>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ spendCapUsd: parsed.data }),
      });
      setValue(settings.spendCapUsd.toFixed(2));
      setStatus('saved');
      router.refresh();
    } catch (err) {
      setStatus('idle');
      setError(
        err instanceof ApiError
          ? err.message
          : 'The cap was not saved. Check Magpipe is running and try again.',
      );
    }
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-3">
      <div className="max-w-[16rem]">
        <Input
          label="Cap per day, in dollars"
          description={disabledReason ?? '0 means no cap.'}
          inputMode="decimal"
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
      {/* Always mounted, so the saved cap is announced wherever focus is. */}
      <p role="status" aria-live="polite" className="sr-only">
        {status === 'saved' ? `Saved. The cap is now ${capWords(value)}.` : ''}
      </p>
      <div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={status === 'saving'}
          disabled={Boolean(disabledReason)}
        >
          {status === 'saved' ? 'Saved' : 'Save cap'}
        </Button>
      </div>
    </form>
  );
}
