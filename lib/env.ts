import 'server-only';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  MAGPIPE_DATA_DIR: z.string().optional(),
  MAGPIPE_DESKTOP: bool,
  MAGPIPE_CONFIG_PATH: z.string().optional(),
  MAGPIPE_REGION: z.string().optional(),
  /** base64url, 32 bytes: encrypts tool credentials (lib/secrets.ts). */
  MAGPIPE_SECRET_KEY: z.string().optional(),
  /** `scripted` swaps the model for a local stub — development and tests only, never production. */
  MAGPIPE_MODEL_STUB: z.enum(['scripted']).optional(),
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),
  VERCEL_REGION: z.string().optional(),
});

/** Validated server env. Empty strings count as unset. */
export const env = schema.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
);

export const isDesktop = env.MAGPIPE_DESKTOP;
