import Link from 'next/link';
import { Avatar } from '@/components/ui/Avatar';
import { StatusPill } from '@/components/ui/StatusPill';
import { cardFooter, type AgentCardData } from '@/lib/home-util';

/**
 * One bird on the wire (spec §5.4): who it is, its status, what it is doing (or did last), how
 * far its current run has got, its model and what it has spent. The name opens the agent.
 */
export function AgentCard({ card, now }: { card: AgentCardData; now: Date }) {
  const pct = card.progress === null ? 0 : Math.round(card.progress * 100);
  return (
    <article aria-label={card.name} className="flex min-w-0 flex-1 flex-col gap-4 card p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar initials={card.initials} size={40} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              href={`/agents?agent=${card.slug}`}
              className="truncate text-display-sm text-ink-strong underline-offset-4 hover:underline"
            >
              {card.name}
            </Link>
            <span className="truncate text-caption text-mute">{card.role}</span>
          </div>
        </div>
        <StatusPill variant={card.status} />
      </div>
      <p className="line-clamp-2 min-h-10 text-body-sm text-body">
        {card.live ? card.task : card.task ? `Last: ${card.task}` : 'Ready for a first task.'}
      </p>
      {card.progress !== null ? (
        <div
          role="progressbar"
          aria-label={`Current run, ${pct}% of steps settled`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 overflow-hidden rounded-pill bg-canvas-soft"
        >
          <div
            className="h-full rounded-pill bg-(image:--g-progress) transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : (
        <div aria-hidden className="h-1 rounded-pill bg-canvas-soft" />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <span className="rounded-sm bg-canvas-soft px-2 py-0.5 font-mono text-code text-code-ink">
          {card.model}
        </span>
        <span className="font-mono text-code text-mute">{cardFooter(card, now)}</span>
      </div>
    </article>
  );
}
