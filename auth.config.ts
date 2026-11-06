import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe part of the Auth.js config, shared by `middleware.ts` and `auth.ts`.
 * Providers live in `auth.ts`. Only used in the `signin` access mode (docs/decisions.md D4).
 */
export const authConfig = {
  pages: { signIn: '/signin' },
  // JWT sessions so middleware can verify a session without a database round-trip.
  session: { strategy: 'jwt' },
  // Required off-Vercel: the desktop app serves on localhost:<port>.
  trustHost: true,
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
