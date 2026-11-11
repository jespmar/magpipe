import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lower case

export type IdPrefix = 'agt' | 'run' | 'step' | 'evt' | 'tool' | 'mem' | 'upl' | 'sec' | 'iss';

/** Document ids are prefixed random strings (`agt_7k2m…`) — see docs/decisions.md D2. */
export function newId(prefix: IdPrefix, length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** `flight_8f3a21` — base36 of the run counter (spec §6). */
export function toDisplayId(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError(`invalid run sequence: ${seq}`);
  return `flight_${seq.toString(36)}`;
}

export function fromDisplayId(displayId: string): number | null {
  const m = /^flight_([0-9a-z]+)$/.exec(displayId);
  return m ? parseInt(m[1]!, 36) : null;
}
