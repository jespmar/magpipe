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
  /** How runs reach Claude (D22): the Claude Code on this machine (default) or the Messages API with a key. */
  MAGPIPE_MODEL_BACKEND: z.enum(['api', 'claude-code']).optional(),
  /** Where the `claude` command is, when it is not on the login shell's PATH. */
  MAGPIPE_CLAUDE_PATH: z.string().optional(),
  /** This server's own origin for the MCP endpoint, when it is not http://127.0.0.1:$PORT. */
  MAGPIPE_SELF_URL: z.string().optional(),
  AUTH_GITHUB_ID: z.string().optional(),
  AUTH_GITHUB_SECRET: z.string().optional(),
  VERCEL_REGION: z.string().optional(),
});

/** Validated server env. Empty strings count as unset. */
export const env = schema.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')),
);

export const isDesktop = env.MAGPIPE_DESKTOP;
