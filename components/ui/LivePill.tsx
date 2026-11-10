import { Badge } from '@/components/arc/badge/badge';

/**
 * How many agents are running right now. `null` = the database is unavailable, so the badge
 * says so instead of claiming zero. On phones the noun is visually hidden but still read out.
 */
export function LivePill({ count }: { count: number | null }) {
  const unknown = count === null;
  const live = (count ?? 0) > 0;
  return (
    <Badge
      tone={live ? 'info' : 'neutral'}
      dot
      pill
      size="lg"
      title={unknown ? 'The database could not be opened' : undefined}
    >
      {unknown ? (
        'Status unavailable'
      ) : (
        <span>
          {count}{' '}
          <span className="sr-only sm:not-sr-only">{count === 1 ? 'agent' : 'agents'} </span>
          active
        </span>
      )}
    </Badge>
  );
}
