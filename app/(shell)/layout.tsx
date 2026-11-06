import { AppShell } from '@/components/AppShell';

// Every screen reads live data (nav pill, session) — never prerender.
export const dynamic = 'force-dynamic';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
