import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from './env';
import type { Db } from './db';

/**
 * PIN handling.
 *
 * A 4-digit PIN has only 10,000 possibilities, so no hash function can make a stolen hash safe
 * on its own. We use HMAC-SHA256 with a server-side secret (PIN_PEPPER) that lives in Vercel's
 * environment settings, never in the database. A leaked database alone therefore reveals nothing;
 * the real protection is the online brute-force limits in auth-core.ts.
 *
 * The HMAC is deterministic, which is what lets the database enforce "no two members share a PIN"
 * with a unique index.
 */

export const PIN_PATTERN = /^\d{4}$/;

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export function hashPin(pin: string, pepper = env.pinPepper): string {
  if (!isValidPinFormat(pin)) throw new Error('PIN must be exactly four digits');
  return createHmac('sha256', pepper).update(`ksb-pin:v1:${pin}`).digest('hex');
}

export function pinMatches(pin: string, storedHash: string | null): boolean {
  if (!storedHash || !isValidPinFormat(pin)) return false;
  const a = Buffer.from(hashPin(pin), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Obvious PINs that are never issued. */
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '1230', '2345', '3456', '4567', '5678', '6789', '9876', '1212', '6969', '1004', '2000', '1886']);

export function randomPin(): string {
  for (;;) {
    const pin = String(randomInt(0, 10000)).padStart(4, '0');
    if (!WEAK.has(pin)) return pin;
  }
}

/**
 * Issue a fresh, unused PIN to a member (inside the caller's transaction).
 * Returns the plain PIN exactly once; only the hash is stored.
 */
export async function issuePin(db: Db, memberId: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = randomPin();
    const hash = hashPin(pin);
    const clash = await db`select 1 from members where pin_hash = ${hash} and id <> ${memberId}`;
    if (clash.length) continue;
    await db`
      update members
      set pin_hash = ${hash}, pin_set_at = now(), failed_pin_attempts = 0, lockout_count = 0,
          locked_until = null, updated_at = now()
      where id = ${memberId}`;
    // Any existing sessions for this member end when their PIN changes.
    await db`update sessions set revoked_at = now() where member_id = ${memberId} and revoked_at is null`;
    return pin;
  }
  throw new Error('Could not find an unused PIN. Please try again.');
}
