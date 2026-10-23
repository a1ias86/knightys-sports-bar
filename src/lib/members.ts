import { sql, isUniqueViolation } from './db';
import { audit, type Actor } from './audit';
import { issuePin } from './pin';
import { revokeAllSessionsFor } from './auth-core';

export interface MemberRow {
  id: string;
  displayName: string;
  role: 'member' | 'admin';
  isActive: boolean;
  hasPin: boolean;
  pinSetAt: Date | null;
  lockedUntil: Date | null;
  openingPoints: number;
  matchPoints: number;
  adjustmentPoints: number;
  totalPoints: number;
  predictions: number;
}

export interface IssuedPin {
  memberId: string;
  displayName: string;
  pin: string;
}

export async function listMembers(): Promise<MemberRow[]> {
  return sql<MemberRow[]>`
    select m.id, m.display_name, m.role, m.is_active, (m.pin_hash is not null) as has_pin, m.pin_set_at,
           case when m.locked_until > now() then m.locked_until end as locked_until,
           t.opening_points, t.match_points, t.adjustment_points, t.total_points,
           (select count(*)::int from predictions p where p.member_id = m.id) as predictions
    from members m join member_totals t on t.member_id = m.id
    order by m.is_active desc, lower(m.display_name)`;
}

/** Names for the login dropdown: active members only. No other data is exposed before login. */
export async function loginNames(): Promise<{ id: string; displayName: string }[]> {
  return sql<{ id: string; displayName: string }[]>`
    select id, display_name from members where is_active and pin_hash is not null order by lower(display_name)`;
}

function cleanName(name: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim();
  return n.length >= 1 && n.length <= 40 ? n : null;
}

export async function addMember(actor: Actor, name: string, openingPoints: number): Promise<{ ok: true; issued: IssuedPin } | { ok: false; error: string }> {
  const n = cleanName(name);
  if (!n) return { ok: false, error: 'Enter a name (1-40 characters).' };
  if (!Number.isInteger(openingPoints) || openingPoints < 0 || openingPoints > 1000) return { ok: false, error: 'Opening points must be a whole number from 0 to 1000.' };
  try {
    return await sql.begin(async (tx) => {
      const [m] = await tx<{ id: string }[]>`insert into members (display_name, role) values (${n}, 'member') returning id`;
      await tx`insert into opening_balances (member_id, points, source) values (${m.id}, ${openingPoints}, ${'Added by ' + actor.displayName})`;
      const pin = await issuePin(tx, m.id);
      await audit(tx, actor, 'member.created', 'member', m.id, { name: n, openingPoints });
      return { ok: true as const, issued: { memberId: m.id, displayName: n, pin } };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'A member with that name already exists. Reactivate them instead.' };
    throw e;
  }
}

export async function renameMember(actor: Actor, memberId: string, name: string) {
  const n = cleanName(name);
  if (!n) return { ok: false as const, error: 'Enter a name (1-40 characters).' };
  try {
    await sql.begin(async (tx) => {
      const [before] = await tx<{ displayName: string }[]>`select display_name from members where id = ${memberId}`;
      await tx`update members set display_name = ${n}, updated_at = now() where id = ${memberId}`;
      await audit(tx, actor, 'member.renamed', 'member', memberId, { from: before?.displayName, to: n });
    });
    return { ok: true as const };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false as const, error: 'Another member already has that name.' };
    throw e;
  }
}

export async function setMemberActive(actor: Actor, memberId: string, active: boolean) {
  if (!active && memberId === actor.id) return { ok: false as const, error: "You can't deactivate yourself." };
  await sql.begin(async (tx) => {
    const [m] = await tx<{ role: string }[]>`select role from members where id = ${memberId} for update`;
    if (!m) throw new Error('Member not found');
    if (!active && m.role === 'admin') {
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from members where role = 'admin' and is_active and id <> ${memberId}`;
      if (c.n === 0) throw new Error('At least one active admin is required.');
    }
    await tx`update members set is_active = ${active}, updated_at = now() where id = ${memberId}`;
    if (!active) await revokeAllSessionsFor(tx, memberId);
    await audit(tx, actor, active ? 'member.reactivated' : 'member.deactivated', 'member', memberId, {});
  });
  return { ok: true as const };
}

export async function setMemberRole(actor: Actor, memberId: string, role: 'member' | 'admin') {
  if (memberId === actor.id && role !== 'admin') return { ok: false as const, error: "You can't remove your own admin role." };
  await sql.begin(async (tx) => {
    await tx`update members set role = ${role}, updated_at = now() where id = ${memberId}`;
    await revokeAllSessionsFor(tx, memberId);
    await audit(tx, actor, 'member.role_changed', 'member', memberId, { role });
  });
  return { ok: true as const };
}

/** Reset one member's PIN. The new PIN is returned once and never stored. */
export async function resetPin(actor: Actor, memberId: string): Promise<IssuedPin> {
  return sql.begin(async (tx) => {
    const [m] = await tx<{ displayName: string }[]>`select display_name from members where id = ${memberId} for update`;
    if (!m) throw new Error('Member not found');
    const pin = await issuePin(tx, memberId);
    await audit(tx, actor, 'member.pin_reset', 'member', memberId, { name: m.displayName });
    return { memberId, displayName: m.displayName, pin };
  });
}

/** Issue PINs to every active member who doesn't have one yet (initial distribution). */
export async function issueMissingPins(actor: Actor): Promise<IssuedPin[]> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; displayName: string }[]>`
      select id, display_name from members where is_active and pin_hash is null order by lower(display_name) for update`;
    const issued: IssuedPin[] = [];
    for (const r of rows) issued.push({ memberId: r.id, displayName: r.displayName, pin: await issuePin(tx, r.id) });
    await audit(tx, actor, 'member.pins_issued', 'member', null, { pinsIssued: issued.length, members: issued.map((i) => i.displayName) });
    return issued;
  });
}

export async function unlockMember(actor: Actor, memberId: string) {
  await sql.begin(async (tx) => {
    await tx`update members set locked_until = null, failed_pin_attempts = 0 where id = ${memberId}`;
    await audit(tx, actor, 'member.unlocked', 'member', memberId, {});
  });
}

// ─── Points adjustments ───────────────────────────────────────

export async function addAdjustment(actor: Actor, memberId: string, points: number, reason: string, fixtureId: string | null) {
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100) return { ok: false as const, error: 'Points must be a non-zero whole number between -100 and 100.' };
  if (!reason || reason.trim().length < 5) return { ok: false as const, error: 'Give a reason (at least 5 characters).' };
  await sql.begin(async (tx) => {
    const [a] = await tx<{ id: string }[]>`
      insert into point_adjustments (member_id, points, reason, fixture_id, created_by)
      values (${memberId}, ${points}, ${reason.trim()}, ${fixtureId}, ${actor.id}) returning id`;
    await audit(tx, actor, 'points.adjusted', 'member', memberId, { adjustmentId: a.id, points, reason: reason.trim(), fixtureId });
  });
  return { ok: true as const };
}

export async function listAdjustments() {
  return sql<{ id: string; memberName: string; points: number; reason: string; createdByName: string; createdAt: Date; opponent: string | null }[]>`
    select a.id, m.display_name as member_name, a.points, a.reason, cb.display_name as created_by_name, a.created_at, f.opponent
    from point_adjustments a
    join members m on m.id = a.member_id
    join members cb on cb.id = a.created_by
    left join fixtures f on f.id = a.fixture_id
    order by a.created_at desc`;
}
