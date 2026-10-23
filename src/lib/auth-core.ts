import { createHash, randomBytes } from 'node:crypto';
import { sql, type Db } from './db';
import { isValidPinFormat, pinMatches } from './pin';
import { audit } from './audit';

/**
 * Login and session logic, independent of Next.js so it can be tested directly.
 *
 * Brute-force protection (4-digit PINs = 10,000 combinations):
 *  - Per member: 5 wrong PINs lock the account for 15 min; each further lockout doubles (max 24 h).
 *    The lock is checked BEFORE the PIN, so a locked account reveals nothing.
 *  - Per IP address: 10 failures in 15 min, or 40 in 24 h, blocks that address.
 *  - Every failed attempt costs ~400 ms.
 * Worst case for a single attacker on one IP: well under 1% of the PIN space per member per day.
 */

export const LIMITS = {
  memberFailuresBeforeLock: 5,
  baseLockMinutes: 15,
  maxLockMinutes: 24 * 60,
  ipFailures15m: 10,
  ipFailures24h: 40,
  failureDelayMs: 400,
  memberSessionDays: 30,
  adminSessionDays: 7,
};

export type Role = 'member' | 'admin';

export interface SessionMember {
  id: string;
  displayName: string;
  role: Role;
  sessionId: string;
}

export type LoginResult =
  | { ok: true; token: string; member: SessionMember; expiresAt: Date }
  | { ok: false; error: string; retryAfterMinutes?: number };

const GENERIC_FAIL = 'That name and PIN do not match.';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function attemptLogin(
  memberId: string,
  pin: string,
  ip: string,
  userAgent: string | null,
  opts: { delay?: boolean } = {},
): Promise<LoginResult> {
  const delay = opts.delay ?? true;
  const fail = async (error: string, retryAfterMinutes?: number): Promise<LoginResult> => {
    if (delay) await sleep(LIMITS.failureDelayMs);
    return { ok: false, error, retryAfterMinutes };
  };

  // Per-IP block, checked first.
  const [ipStats] = await sql<{ f15: number; f24: number }[]>`
    select
      count(*) filter (where created_at > now() - interval '15 minutes')::int as f15,
      count(*)::int as f24
    from login_attempts
    where ip = ${ip} and not success and created_at > now() - interval '24 hours'`;
  if (ipStats.f15 >= LIMITS.ipFailures15m || ipStats.f24 >= LIMITS.ipFailures24h) {
    return fail('Too many attempts from this device. Please wait and try again later.', ipStats.f24 >= LIMITS.ipFailures24h ? 24 * 60 : 15);
  }

  const uuidLike = typeof memberId === 'string' && /^[0-9a-f-]{36}$/i.test(memberId);
  if (!uuidLike || !isValidPinFormat(pin)) {
    await sql`insert into login_attempts (member_id, ip, success) values (null, ${ip}, false)`;
    return fail(GENERIC_FAIL);
  }

  const result = await sql.begin(async (tx) => {
    const [m] = await tx<{
      id: string; displayName: string; role: Role; isActive: boolean; pinHash: string | null;
      failedPinAttempts: number; lockoutCount: number; lockedUntil: Date | null; lockedNow: boolean;
    }[]>`
      select id, display_name, role, is_active, pin_hash, failed_pin_attempts, lockout_count, locked_until,
             (locked_until is not null and locked_until > now()) as locked_now
      from members where id = ${memberId} for update`;

    if (!m || !m.isActive || !m.pinHash) {
      await tx`insert into login_attempts (member_id, ip, success) values (${m?.id ?? null}, ${ip}, false)`;
      return { ok: false as const, error: GENERIC_FAIL };
    }

    if (m.lockedNow) {
      await tx`insert into login_attempts (member_id, ip, success) values (${m.id}, ${ip}, false)`;
      const mins = Math.max(1, Math.ceil((m.lockedUntil!.getTime() - Date.now()) / 60000));
      return { ok: false as const, error: `Too many wrong PINs for this name. Try again in about ${mins} minute${mins === 1 ? '' : 's'}, or ask Jon or Knighty to reset your PIN.`, retryAfterMinutes: mins };
    }

    if (!pinMatches(pin, m.pinHash)) {
      const failures = m.failedPinAttempts + 1;
      if (failures >= LIMITS.memberFailuresBeforeLock) {
        const lockouts = m.lockoutCount + 1;
        const minutes = Math.min(LIMITS.baseLockMinutes * 2 ** (lockouts - 1), LIMITS.maxLockMinutes);
        await tx`
          update members set failed_pin_attempts = 0, lockout_count = ${lockouts},
            locked_until = now() + make_interval(mins => ${minutes}) where id = ${m.id}`;
        await audit(tx, null, 'auth.member_locked', 'member', m.id, { minutes, ip });
      } else {
        await tx`update members set failed_pin_attempts = ${failures} where id = ${m.id}`;
      }
      await tx`insert into login_attempts (member_id, ip, success) values (${m.id}, ${ip}, false)`;
      return { ok: false as const, error: GENERIC_FAIL };
    }

    // Success
    const token = randomBytes(32).toString('base64url');
    const days = m.role === 'admin' ? LIMITS.adminSessionDays : LIMITS.memberSessionDays;
    const [s] = await tx<{ id: string; expiresAt: Date }[]>`
      insert into sessions (token_hash, member_id, expires_at, ip, user_agent)
      values (${hashToken(token)}, ${m.id}, now() + make_interval(days => ${days}), ${ip}, ${userAgent?.slice(0, 300) ?? null})
      returning id, expires_at`;
    await tx`update members set failed_pin_attempts = 0, lockout_count = 0, locked_until = null where id = ${m.id}`;
    await tx`insert into login_attempts (member_id, ip, success) values (${m.id}, ${ip}, true)`;
    return {
      ok: true as const,
      token,
      expiresAt: s.expiresAt,
      member: { id: m.id, displayName: m.displayName, role: m.role, sessionId: s.id },
    };
  });

  if (!result.ok) return fail(result.error, 'retryAfterMinutes' in result ? result.retryAfterMinutes : undefined);

  // Light housekeeping (cheap, indexed).
  if (Math.random() < 0.05) {
    await sql`delete from login_attempts where created_at < now() - interval '30 days'`;
    await sql`delete from sessions where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days'`;
  }
  return result;
}

export async function getSessionMember(token: string | undefined | null): Promise<SessionMember | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const rows = await sql<(SessionMember & { lastSeenAt: Date })[]>`
    select m.id, m.display_name, m.role, s.id as session_id, s.last_seen_at
    from sessions s join members m on m.id = s.member_id
    where s.token_hash = ${hashToken(token)} and s.revoked_at is null and s.expires_at > now() and m.is_active`;
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.lastSeenAt).getTime() > 5 * 60_000) {
    await sql`update sessions set last_seen_at = now() where id = ${row.sessionId}`;
  }
  return { id: row.id, displayName: row.displayName, role: row.role, sessionId: row.sessionId };
}

export async function revokeSession(db: Db, token: string) {
  await db`update sessions set revoked_at = now() where token_hash = ${hashToken(token)} and revoked_at is null`;
}

export async function revokeAllSessionsFor(db: Db, memberId: string) {
  await db`update sessions set revoked_at = now() where member_id = ${memberId} and revoked_at is null`;
}
