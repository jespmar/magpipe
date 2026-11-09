import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sealSecret, secretsReady, SecretKeyError, unsealSecret } from '@/lib/secrets';

const KEY = Buffer.from('unit-test-key-unit-test-key-0123').toString('base64url');

describe('secrets', () => {
  const previous = process.env.MAGPIPE_SECRET_KEY;
  beforeEach(() => {
    process.env.MAGPIPE_SECRET_KEY = KEY;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MAGPIPE_SECRET_KEY;
    else process.env.MAGPIPE_SECRET_KEY = previous;
  });

  it('round-trips a credential and never stores it in the clear', () => {
    const sealed = sealSecret('sk-live-very-secret');
    expect(sealed.ciphertext).not.toContain('secret');
    expect(unsealSecret(sealed)).toBe('sk-live-very-secret');
    expect(sealSecret('x').iv).not.toBe(sealSecret('x').iv);
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = sealSecret('token');
    const tampered = { ...sealed, ciphertext: Buffer.from('zzzz').toString('base64') };
    expect(() => unsealSecret(tampered)).toThrow();
  });

  it('explains when no key is configured', () => {
    delete process.env.MAGPIPE_SECRET_KEY;
    expect(secretsReady()).toBe(false);
    expect(() => sealSecret('token')).toThrow(SecretKeyError);
    process.env.MAGPIPE_SECRET_KEY = 'too-short';
    expect(secretsReady()).toBe(false);
  });
});
