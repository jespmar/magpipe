import { AppShell } from '@/components/AppShell';
import { NotFoundBody } from '@/components/NotFoundBody';

/** Unmatched URLs keep the shell, so the nav is still there to leave by. */
export default async function NotFound() {
  return (
    <AppShell>
      <NotFoundBody />
    </AppShell>
  );
}
