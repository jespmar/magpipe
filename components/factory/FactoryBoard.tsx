import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/arc/badge/badge';
import type { Board, BoardCard, BoardVerdict } from '@/lib/factory-board';
import type { IssueStage } from '@/lib/schemas';
import { PIPELINE_LABELS } from '@/lib/tracker/labels';
import { GateActions } from './GateActions';

const TONE: Record<BoardVerdict['verdict'], 'success' | 'danger' | 'neutral'> = {
  pass: 'success',
  fail: 'danger',
  failed: 'danger',
  skipped: 'neutral',
  none: 'neutral',
};

/** What an empty column means, in the board's own words. */
const EMPTY: Record<IssueStage, string> = {
  spec_ready: 'No spec waiting for approval.',
  approved: 'Nothing approved and waiting to start.',
  building: 'Nothing building.',
  merge_question: 'No question to merge.',
  done: 'Nothing done yet.',
  needs_you: 'Nothing needs you.',
  other: 'No issue in an unmapped status.',
};

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1 font-mono text-code text-ink hover:text-ink-strong"
    >
      {children}
      <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
      <span className="sr-only">(opens in the browser)</span>
    </a>
  );
}

function Card({ card }: { card: BoardCard }) {
  const gate =
    card.kind === 'spec' && card.stage === 'spec_ready'
      ? 'approve'
      : card.kind === 'goal' && card.stage === 'merge_question' && card.pr && !card.mergeRequested
        ? 'question'
        : null;
  return (
    <li className="flex min-w-0 flex-col gap-2 card p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <External href={card.url}>{card.identifier}</External>
        <span className="text-caption text-mute">
          {card.kind === 'spec' ? 'spec' : card.parent ? `goal of ${card.parent}` : 'goal'}
          {card.project ? ` · ${card.project}` : ''}
        </span>
      </div>
      <p className="text-body-sm text-ink">{card.title}</p>
      {card.goals && card.goals.total > 0 ? (
        <p className="font-mono text-code text-mute">
          {card.goals.done} of {card.goals.total} goals done
        </p>
      ) : null}
      {card.branch ? (
        <p className="font-mono text-code break-all text-mute">{card.branch}</p>
      ) : null}
      {card.pr ? (
        <p className="flex flex-wrap items-center gap-2">
          <External href={card.pr.url}>{`PR #${card.pr.number}`}</External>
          {card.merged ? (
            <Badge tone="success">merged</Badge>
          ) : card.mergeRequested ? (
            <Badge tone="neutral">{card.mergeVia === 'rule' ? 'merging by rule' : 'merging'}</Badge>
          ) : null}
        </p>
      ) : null}
      {card.verdicts.length > 0 ? (
        <ul aria-label={`${card.identifier} checks`} className="flex flex-col gap-1">
          {card.verdicts.map((v) => (
            <li key={v.title} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-caption text-body">{v.title}</span>
              <Badge tone={TONE[v.verdict]}>
                {v.verdict === 'none' ? 'no verdict' : v.verdict}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {card.runs.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-mute">
          {card.runs.map(({ label, run }) => (
            <span key={label}>
              {label}{' '}
              <Link
                href={`/runs/${run.displayId}`}
                className="font-mono text-code text-ink underline-offset-4 hover:underline"
              >
                {run.displayId}
              </Link>{' '}
              · {run.status}
            </span>
          ))}
        </p>
      ) : null}
      {gate ? <GateActions issueId={card.id} identifier={card.identifier} gate={gate} /> : null}
    </li>
  );
}

/**
 * The factory board (D43): every spec and goal by pipeline stage, as columns at wide widths and
 * three across below that. Both gates live on the cards that wait for them.
 */
export function FactoryBoard({ board }: { board: Board }) {
  return (
    <div className="grid items-start gap-4 md:grid-cols-3 wide:grid-cols-6">
      {board.columns.map((col) => (
        <section
          key={col.stage}
          aria-label={PIPELINE_LABELS[col.stage]}
          className="flex min-w-0 flex-col gap-3"
        >
          <h2 className="flex items-baseline justify-between gap-2 font-medium text-body text-ink">
            {PIPELINE_LABELS[col.stage]}
            <span className="font-mono text-code text-mute">{col.cards.length}</span>
          </h2>
          {col.cards.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {col.cards.map((c) => (
                <Card key={c.id} card={c} />
              ))}
            </ul>
          ) : (
            <p className="text-caption text-mute">{EMPTY[col.stage]}</p>
          )}
        </section>
      ))}
    </div>
  );
}
