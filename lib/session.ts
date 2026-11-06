import 'server-only';
import { cache } from 'react';
import { auth } from '@/auth';
import { accessMode, LOCAL_USER } from './auth-mode';

export type CurrentUser = {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

/** The signed-in user, or the local user on desktop / with auth disabled. Cached per request. */
export const currentUser = cache(async (): Promise<CurrentUser | null> => {
  if (accessMode() !== 'signin') return { ...LOCAL_USER };
  const session = await auth();
  if (!session?.user) return null;
  const { id, name, email, image } = session.user;
  return { id, name: name ?? null, email: email ?? null, image: image ?? null };
});
