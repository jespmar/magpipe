import 'server-only';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { currentUser, type CurrentUser } from './session';

/** Error envelope for every route handler (spec §8). */
export function apiError(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Middleware already blocks anonymous requests; this is the belt to its braces. */
export async function requireUser(): Promise<CurrentUser | NextResponse> {
  const user = await currentUser();
  return user ?? apiError('unauthorized', 'Sign in required', 401);
}

export async function parseBody<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return { ok: false, res: apiError('invalid_json', 'Body must be JSON') };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return {
      ok: false,
      res: apiError('validation', `${where}${first?.message ?? 'invalid body'}`),
    };
  }
  return { ok: true, data: parsed.data };
}
