import { timingSafeEqual } from 'node:crypto';
import { sql } from './db';
import { issuePin } from './pin';
import { audit } from './audit';
import type { IssuedPin } from './members';

/**
 * First-run administrator setup.
 * Allowed only while NO active admin has a PIN. Issues PINs to every active admin (Jon and Knighty)
 * and shows them once. After that, admins issue all other PINs from the admin area.
 */
export async function setupAvailable(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from members where role = 'admin' and is_active and pin_hash is not null`;
  return r.n === 0;
}

export function tokenMatches(given: string, expected: string): boolean {
  if (!expected || expected.length < 16 || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function bootstrapAdmins(via: string): Promise<IssuedPin[] | null> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727275)`;
    const [r] = await tx<{ n: number }[]>`select count(*)::int as n from members where role = 'admin' and is_active and pin_hash is not null`;
    if (r.n > 0) return null;
    const admins = await tx<{ id: string; displayName: string }[]>`
      select id, display_name from members where role = 'admin' and is_active order by lower(display_name)`;
    const issued: IssuedPin[] = [];
    for (const a of admins) issued.push({ memberId: a.id, displayName: a.displayName, pin: await issuePin(tx, a.id) });
    await audit(tx, null, 'admin.bootstrap', 'member', null, { via, admins: issued.map((i) => i.displayName) });
    return issued;
  });
}
