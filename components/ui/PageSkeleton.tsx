import { Skeleton } from '@/components/arc/skeleton/skeleton';

/**
 * Route-transition skeleton in the shape of a page head, not a spinner. Each list segment has a
 * `loading.tsx` that re-exports this; the run detail route deliberately has none, because a
 * streaming boundary above a page that calls `notFound()` would answer 200 before the 404.
 */
export function PageSkeleton() {
  return <Skeleton lines={3} label="Loading page" className="max-w-[40rem]" />;
}
