import { clsx } from 'clsx';
import type { RunArtifact } from '@/lib/schemas';

/**
 * What a run produced (D29): each branch it committed to and each file it created or changed in
 * a bound repository, as recorded from the tools, plus any uploaded file. Mono facts only.
 */
export function ArtifactList({
  artifacts,
  className,
}: {
  artifacts: RunArtifact[];
  className?: string;
}) {
  if (artifacts.length === 0) return null;
  return (
    <ul aria-label="What changed" className={clsx('flex flex-col gap-1.5', className)}>
      {artifacts.map((a) => {
        const facts =
          a.blobUrl ??
          [a.kind === 'branch' ? 'branch' : null, a.repo, a.detail].filter(Boolean).join(' · ');
        return (
          <li
            key={`${a.kind ?? 'upload'}:${a.repo ?? ''}:${a.name}:${a.blobUrl ?? ''}`}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3"
          >
            <span className="font-mono text-code [overflow-wrap:anywhere] text-ink">{a.name}</span>
            <span
              className={clsx(
                'min-w-0 truncate font-mono text-caption text-mute',
                a.blobUrl && 'select-all',
              )}
            >
              {facts}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
