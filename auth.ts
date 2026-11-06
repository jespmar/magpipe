import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import GitHub from 'next-auth/providers/github';
import { authConfig } from './auth.config';
import { env } from '@/lib/env';

// Sign-in is only used by a hosted deployment (access mode `signin`, docs/decisions.md D4).
// The desktop app is gated by its per-launch token instead.
const providers: Provider[] = [];
if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) providers.push(GitHub);

export const { handlers, auth, signIn, signOut } = NextAuth({ ...authConfig, providers });

/** Provider list for the sign-in page. */
export const enabledProviders = providers.map((p) => {
  const cfg = typeof p === 'function' ? p() : p;
  return { id: cfg.id, name: cfg.name, type: cfg.type };
});
