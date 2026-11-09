import { clsx } from 'clsx';
import { stepMeta, type AgentChip } from '@/lib/runs-util';
import type { Step } from '@/lib/schemas';

type Props = {
  plan: Step[];
  agents: AgentChip[];
  now: Date;
  /** What to say when the plan is still empty. */
  emptyMessage?: string;
};

const STEP_STYLE: Record<Step['status'], { card: string; dot: string; label: string }> = {
  done: { card: 'border-hairline bg-canvas', dot: 'bg-emerald', label: 'text-mute' },
  live: {
    card: 'border-cyan/60 bg-[rgba(34,193,220,0.08)]',
    dot: 'bg-cyan motion-safe:animate-blink',
    label: 'text-cyan',
  },
  failed: { card: 'border-danger/50 bg-canvas', dot: 'bg-danger', label: 'text-danger' },
  todo: { card: 'border-hairline-soft bg-canvas', dot: 'bg-mute opacity-60', label: 'text-mute' },
  skipped: {
    card: 'border-dashed border-hairline-soft bg-canvas',
    dot: 'bg-mute opacity-60',
    label: 'text-mute',
  },
};

/**
 * The plan as a chain of step cards, `AGENT · what · meta` (spec §3.4): a horizontal chain with
 * arrows below 1600 px, a vertical timeline from there. Done is an emerald dot, the live step a
 * cyan edge and fill, failed red, waiting grey.
 */
export function RunFlightPath({ plan, agents, now, emptyMessage }: Props) {
  if (plan.length === 0) {
    return <p className="text-body-sm text-body">{emptyMessage ?? 'No steps were planned.'}</p>;
  }
  return (
    <ol
      aria-label="Flight path"
      className="flex items-stretch overflow-x-auto pb-1 wide:flex-col wide:overflow-visible wide:pb-0"
    >
      {plan.map((s, i) => {
        const style = STEP_STYLE[s.status];
        const label =
          s.agentId === null
            ? 'Magpipe'
            : (agents.find((a) => a.id === s.agentId)?.name ?? 'agent');
        return (
          <li
            key={s.id}
            aria-current={s.status === 'live' ? 'step' : undefined}
            className="flex shrink-0 items-center wide:flex-col wide:items-stretch"
          >
            <div
              className={clsx(
                'flex w-[196px] flex-col gap-1.5 rounded-md border px-3.5 py-3 wide:w-full',
                style.card,
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={clsx(
                    'truncate text-caption font-semibold tracking-[1.2px] uppercase',
                    style.label,
                  )}
                >
                  {label}
                </span>
                <span
                  role="img"
                  aria-label={s.status === 'live' ? 'running' : s.status}
                  className={clsx('size-1.5 shrink-0 rounded-pill', style.dot)}
                />
              </div>
              <span className="line-clamp-3 text-body-sm text-ink">{s.title}</span>
              <span className="font-mono text-caption text-mute">{stepMeta(s, now)}</span>
            </div>
            {i < plan.length - 1 ? (
              <svg
                aria-hidden
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-1 shrink-0 text-mute wide:mx-0 wide:my-1 wide:rotate-90 wide:self-center"
              >
                <path d="M4 12h14M13 7l5 5-5 5" />
              </svg>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
