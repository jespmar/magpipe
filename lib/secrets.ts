/**
 * Tool credentials at rest: AES-256-GCM under MAGPIPE_SECRET_KEY (32 random bytes, base64url).
 * The desktop app generates the key once per install; web dev sets it in .env.local. A tool
 * row only ever holds the `secretRef`; the value is decrypted when a connection is made.
 * docs/decisions.md D13.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import * as t from './db/schema';
import { newId } from './ids';

export class SecretKeyError extends Error {
  readonly code = 'secrets_unavailable';
}

const HINT =
  'Set MAGPIPE_SECRET_KEY to 32 random bytes in base64url (see .env.example); the desktop app sets its own.';

function loadKey(): Buffer | null {
  const raw = process.env.MAGPIPE_SECRET_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64url');
  return key.length === 32 ? key : null;
}

/** Whether credentials can be stored in this process. The UI says so before asking for one. */
export function secretsReady(): boolean {
  return loadKey() !== null;
}

function requireKey(): Buffer {
  const key = loadKey();
  if (!key) throw new SecretKeyError(`Tool credentials can’t be stored yet. ${HINT}`);
  return key;
}

export type Sealed = { ciphertext: string; iv: string; tag: string };

export function sealSecret(plain: string, key: Buffer = requireKey()): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function unsealSecret(sealed: Sealed, key: Buffer = requireKey()): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Encrypts and stores a credential; returns the `secretRef` to keep on the tool. */
export async function storeSecret(db: Db, plain: string): Promise<string> {
  const id = newId('sec');
  await db.insert(t.secrets).values({ id, ...sealSecret(plain), createdAt: new Date() });
  return id;
}

export async function readSecret(db: Db, ref: string): Promise<string | null> {
  const [row] = await db.select().from(t.secrets).where(eq(t.secrets.id, ref));
  return row ? unsealSecret(row) : null;
}

export async function deleteSecret(db: Db, ref: string): Promise<void> {
  await db.delete(t.secrets).where(eq(t.secrets.id, ref));
}
