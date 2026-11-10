import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/arc/alert/alert';
import { enabledProviders, signIn } from '@/auth';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ callbackUrl?: string; error?: string }> };

/** Only same-origin paths, never a bounce to an attacker-supplied URL. */
function safeCallback(url: string | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

/** Only reachable in `signin` access mode (a hosted deployment), see docs/decisions.md D4. */
export default async function SignInPage({ searchParams }: Props) {
  const { callbackUrl, error } = await searchParams;
  const redirectTo = safeCallback(callbackUrl);
  if (await currentUser()) redirect(redirectTo);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 text-ink">
      {/* macOS desktop: a drag strip for the window, without padding the whole page. */}
      <div data-titlebar aria-hidden className="fixed inset-x-0 top-0 h-10" />
      <div className="flex w-full max-w-sm flex-col gap-6 card p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo onDisc size={34} discSize={56} id="mp-wing-signin" label="Magpipe" />
          <div className="flex flex-col gap-1">
            <h1 className="text-display-md text-ink-strong">Sign in to Magpipe</h1>
            <p className="text-body-sm text-body">Agent orchestrator</p>
          </div>
        </div>

        {error ? (
          <Alert tone="danger" title="Sign-in failed">{`${error}. Try again.`}</Alert>
        ) : null}

        {enabledProviders.map((p) => (
          <form
            key={p.id}
            action={async () => {
              'use server';
              await signIn(p.id, { redirectTo });
            }}
            className="[&>button]:w-full"
          >
            <Button type="submit" variant="primary">
              Continue with {p.name}
            </Button>
          </form>
        ))}

        {enabledProviders.length === 0 ? (
          <Alert tone="warning" title="No sign-in providers are configured">
            <span>
              Set <code className="font-mono text-code">AUTH_GITHUB_ID</code> and{' '}
              <code className="font-mono text-code">AUTH_GITHUB_SECRET</code>, or for local
              development <code className="font-mono text-code">MAGPIPE_AUTH_DISABLED=true</code>.
              See <code className="font-mono text-code">.env.example</code>.
            </span>
          </Alert>
        ) : null}
      </div>
    </main>
  );
}
