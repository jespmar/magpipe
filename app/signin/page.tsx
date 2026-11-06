import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { enabledProviders, signIn } from '@/auth';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<{ callbackUrl?: string; error?: string }> };

/** Only same-origin paths — never bounce to an attacker-supplied URL. */
function safeCallback(url: string | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

/** Only reachable in `signin` access mode (a hosted deployment) — see docs/decisions.md D4. */
export default async function SignInPage({ searchParams }: Props) {
  const { callbackUrl, error } = await searchParams;
  const redirectTo = safeCallback(callbackUrl);
  if (await currentUser()) redirect(redirectTo);

  return (
    <main className="flex min-h-dvh items-center justify-center ambient px-4" data-titlebar>
      <div className="flex w-full max-w-sm flex-col gap-6 panel p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo onDisc size={34} discSize={56} id="mp-wing-signin" label="Magpipe" />
          <span className="eyebrow">Agent orchestrator</span>
          <h1 className="text-display-md text-ink-strong">Sign in to Magpipe</h1>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-danger/50 px-3 py-2 text-body-sm text-danger"
          >
            Sign-in failed ({error}). Try again.
          </p>
        ) : null}

        {enabledProviders.map((p) => (
          <form
            key={p.id}
            action={async () => {
              'use server';
              await signIn(p.id, { redirectTo });
            }}
          >
            <Button type="submit" variant="primary" className="w-full">
              Continue with {p.name}
            </Button>
          </form>
        ))}

        {enabledProviders.length === 0 ? (
          <div className="flex flex-col gap-2 text-body-sm text-body">
            <p className="font-semibold text-warn">No sign-in providers are configured.</p>
            <p>
              Set <code className="font-mono text-code">AUTH_GITHUB_ID</code> /{' '}
              <code className="font-mono text-code">AUTH_GITHUB_SECRET</code>, or for local
              development <code className="font-mono text-code">MAGPIPE_AUTH_DISABLED=true</code>.
              See <code className="font-mono text-code">.env.example</code>.
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
