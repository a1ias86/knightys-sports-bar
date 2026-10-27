import { sql, isUniqueViolation, type Db } from './db';
import { audit, type Actor } from './audit';
import { cleanName } from './names';

/**
 * Hall of Fame: one champion per season, entered by an admin. Never generated automatically.
 * Reading is open to everyone; every change checks, on the server, that the actor is an active admin.
 */

export interface HallOfFameEntry {
  id: string;
  seasonLabel: string;
  seasonStart: number;
  winnerName: string;
  memberId: string | null;
  memberName: string | null;
  points: number | null;
  summary: string | null;
  updatedAt: Date;
}

export interface HallOfFameInput {
  season: string;
  winnerName: string;
  memberId: string | null;
  points: string | number | null;
  summary: string | null;
}

/** "2025/26", "2025-26", "2025/2026" or "2025-2026" → { label: '2025/26', start: 2025 }. */
export function parseSeason(raw: string): { label: string; start: number } | null {
  const m = /^\s*(\d{4})\s*[/\-–]\s*(\d{2}|\d{4})\s*$/.exec(raw ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const endFull = m[2].length === 4 ? Number(m[2]) : Math.floor(start / 100) * 100 + Number(m[2]) + (Number(m[2]) < start % 100 ? 100 : 0);
  if (endFull !== start + 1 || start < 1900 || start > 2199) return null;
  return { label: `${start}/${String(endFull % 100).padStart(2, '0')}`, start };
}

const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

interface Clean { label: string; start: number; winner: string; memberId: string | null; points: number | null; summary: string | null }

export function validateHallOfFame(i: HallOfFameInput): { ok: true; value: Clean } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const season = parseSeason(i.season);
  if (!season) errors.push('Enter the season like 2025/26.');
  const winner = cleanName(i.winnerName);
  if (!winner) errors.push("Enter the winner's name.");
  else if (winner.length > 60 || !NAME_OK.test(winner)) errors.push("The winner's name can use letters, spaces, apostrophes, hyphens and full stops (60 characters max).");
  let points: number | null = null;
  const rawPoints = i.points === null || i.points === undefined ? '' : String(i.points).trim();
  if (rawPoints !== '') {
    if (!/^\d{1,5}$/.test(rawPoints) || Number(rawPoints) > 10000) errors.push('Points must be a whole number (or leave it blank).');
    else points = Number(rawPoints);
  }
  const summary = (i.summary ?? '').replace(/\s+/g, ' ').trim();
  if (summary.length > 500) errors.push('Keep the summary under 500 characters.');
  const memberId = i.memberId && /^[0-9a-f-]{36}$/i.test(i.memberId) ? i.memberId : null;
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { label: season!.label, start: season!.start, winner, memberId, points, summary: summary || null } };
}

async function assertAdmin(db: Db, actor: Actor) {
  const [m] = await db<{ ok: boolean }[]>`select (role = 'admin' and is_active) as ok from members where id = ${actor.id}`;
  if (!m?.ok) throw new Error('Only an administrator can change the Hall of Fame.');
}

/** Newest season first. */
export async function listHallOfFame(db: Db = sql): Promise<HallOfFameEntry[]> {
  return db<HallOfFameEntry[]>`
    select h.id, h.season_label, h.season_start, h.winner_name, h.member_id, m.display_name as member_name,
           h.points, h.summary, h.updated_at
    from hall_of_fame h left join members m on m.id = h.member_id
    order by h.season_start desc, h.season_label desc`;
}

type Result = { ok: true; id: string } | { ok: false; error: string };

export async function addHallOfFame(actor: Actor, input: HallOfFameInput): Promise<Result> {
  const v = validateHallOfFame(input);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };
  try {
    return await sql.begin(async (tx) => {
      await assertAdmin(tx, actor);
      if (v.value.memberId) {
        const [m] = await tx`select 1 from members where id = ${v.value.memberId}`;
        if (!m) return { ok: false as const, error: 'That member does not exist.' };
      }
      const [row] = await tx<{ id: string }[]>`
        insert into hall_of_fame (season_label, season_start, winner_name, member_id, points, summary, created_by, updated_by)
        values (${v.value.label}, ${v.value.start}, ${v.value.winner}, ${v.value.memberId}, ${v.value.points}, ${v.value.summary}, ${actor.id}, ${actor.id})
        returning id`;
      await audit(tx, actor, 'hall_of_fame.added', 'hall_of_fame', row.id, { season: v.value.label, winner: v.value.winner, points: v.value.points });
      return { ok: true as const, id: row.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: `There is already a champion for ${v.value.label}. Edit that entry instead.` };
    throw e;
  }
}

export async function updateHallOfFame(actor: Actor, id: string, input: HallOfFameInput): Promise<Result> {
  const v = validateHallOfFame(input);
  if (!v.ok) return { ok: false, error: v.errors.join(' ') };
  try {
    return await sql.begin(async (tx) => {
      await assertAdmin(tx, actor);
      const [before] = await tx<{ seasonLabel: string; winnerName: string; points: number | null }[]>`
        select season_label, winner_name, points from hall_of_fame where id = ${id} for update`;
      if (!before) return { ok: false as const, error: 'That entry no longer exists.' };
      if (v.value.memberId) {
        const [m] = await tx`select 1 from members where id = ${v.value.memberId}`;
        if (!m) return { ok: false as const, error: 'That member does not exist.' };
      }
      await tx`
        update hall_of_fame set season_label = ${v.value.label}, season_start = ${v.value.start}, winner_name = ${v.value.winner},
          member_id = ${v.value.memberId}, points = ${v.value.points}, summary = ${v.value.summary}, updated_by = ${actor.id}, updated_at = now()
        where id = ${id}`;
      await audit(tx, actor, 'hall_of_fame.edited', 'hall_of_fame', id, {
        before, after: { seasonLabel: v.value.label, winnerName: v.value.winner, points: v.value.points },
      });
      return { ok: true as const, id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: `There is already a champion for ${v.value.label}.` };
    throw e;
  }
}

export async function deleteHallOfFame(actor: Actor, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    const [before] = await tx<{ seasonLabel: string; winnerName: string }[]>`
      delete from hall_of_fame where id = ${id} returning season_label, winner_name`;
    if (!before) return { ok: false as const, error: 'That entry no longer exists.' };
    await audit(tx, actor, 'hall_of_fame.deleted', 'hall_of_fame', id, { ...before });
    return { ok: true as const };
  });
}
