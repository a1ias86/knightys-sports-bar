import { sql, isUniqueViolation, type Db } from './db';
import { audit, type Actor } from './audit';

export type FixtureStatus = 'scheduled' | 'postponed' | 'live' | 'finished' | 'abandoned' | 'cancelled';
export type ScoringStatus = 'not_ready' | 'awaiting_verification' | 'review_required' | 'finalised' | 'void';

export interface Fixture {
  id: string;
  provider: string | null;
  providerFixtureId: string | null;
  competitionCode: string;
  competitionName: string;
  competitionEnabled: boolean;
  season: string;
  round: string;
  opponent: string;
  venue: 'H' | 'A' | 'N';
  kickoffAt: Date;
  status: FixtureStatus;
  scoringStatus: ScoringStatus;
  dataSource: 'automatic' | 'manual';
  manualOverride: boolean;
  reviewReason: string | null;
  lastSyncedAt: Date | null;
}

export const FIXTURE_STATUSES: FixtureStatus[] = ['scheduled', 'postponed', 'live', 'finished', 'abandoned', 'cancelled'];

const FIXTURE_COLUMNS = (db: Db) => db`
  f.id, f.provider, f.provider_fixture_id, f.competition_code, c.name as competition_name, c.enabled as competition_enabled,
  f.season, f.round, f.opponent, f.venue, f.kickoff_at, f.status, f.scoring_status, f.data_source,
  f.manual_override, f.review_reason, f.last_synced_at`;

/** '2026-27' for any date from July 2026 to June 2027. */
export function seasonFor(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Predictions are open only for a scheduled match before its stored kickoff time (server clock). */
export function isPredictionOpen(f: Pick<Fixture, 'status' | 'kickoffAt'>, now = new Date()): boolean {
  return f.status === 'scheduled' && new Date(f.kickoffAt).getTime() > now.getTime();
}

/** Has the match started (so locked predictions may be revealed)? */
export function hasKickedOff(f: Pick<Fixture, 'status' | 'kickoffAt'>, now = new Date()): boolean {
  if (f.status === 'live' || f.status === 'finished' || f.status === 'abandoned') return true;
  if (f.status === 'scheduled') return new Date(f.kickoffAt).getTime() <= now.getTime();
  return false;
}

/** Upcoming (not yet played, or kicked off in the last 3 hours) vs played, most recent first. */
export function splitFixtures<T extends Pick<Fixture, 'kickoffAt' | 'status'>>(list: T[], now = new Date()) {
  const cutoff = now.getTime() - 3 * 3600_000;
  const isUpcoming = (f: T) => new Date(f.kickoffAt).getTime() > cutoff && !['finished', 'abandoned', 'cancelled'].includes(f.status);
  return { upcoming: list.filter(isUpcoming), past: list.filter((f) => !isUpcoming(f)).reverse() };
}

export type DisplayStatus =
  | 'open' | 'submitted' | 'locked' | 'live' | 'awaiting' | 'review' | 'completed'
  | 'postponed' | 'abandoned' | 'cancelled' | 'void';

export function displayStatus(f: Pick<Fixture, 'status' | 'kickoffAt' | 'scoringStatus'>, hasPrediction: boolean, now = new Date()): DisplayStatus {
  if (f.status === 'postponed') return 'postponed';
  if (f.status === 'cancelled') return 'cancelled';
  if (f.status === 'abandoned') return 'abandoned';
  if (f.scoringStatus === 'void') return 'void';
  if (f.scoringStatus === 'finalised') return 'completed';
  if (f.status === 'finished') return f.scoringStatus === 'review_required' ? 'review' : 'awaiting';
  if (f.status === 'live') return 'live';
  if (isPredictionOpen(f, now)) return hasPrediction ? 'submitted' : 'open';
  return 'locked';
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  open: 'Open', submitted: 'Submitted', locked: 'Locked', live: 'Live', awaiting: 'Awaiting verification',
  review: 'Scoring review', completed: 'Completed', postponed: 'Postponed', abandoned: 'Abandoned',
  cancelled: 'Cancelled', void: 'Void',
};

export async function getFixture(id: string, db: Db = sql): Promise<Fixture | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db<Fixture[]>`
    select ${FIXTURE_COLUMNS(db)} from fixtures f join competitions c on c.code = f.competition_code where f.id = ${id}`;
  return rows[0] ?? null;
}

export async function listFixtures(opts: { from?: Date; to?: Date; includeDisabled?: boolean; limit?: number; order?: 'asc' | 'desc' } = {}): Promise<Fixture[]> {
  const order = opts.order === 'desc' ? sql`desc` : sql`asc`;
  return sql<Fixture[]>`
    select ${FIXTURE_COLUMNS(sql)} from fixtures f join competitions c on c.code = f.competition_code
    where true
      ${opts.includeDisabled ? sql`` : sql`and c.enabled`}
      ${opts.from ? sql`and f.kickoff_at >= ${opts.from}` : sql``}
      ${opts.to ? sql`and f.kickoff_at < ${opts.to}` : sql``}
    order by f.kickoff_at ${order}
    limit ${opts.limit ?? 500}`;
}

/** The fixture members should be predicting next: soonest open one, else a live/locked one in progress. */
export async function nextFixture(): Promise<Fixture | null> {
  const rows = await sql<Fixture[]>`
    select ${FIXTURE_COLUMNS(sql)} from fixtures f join competitions c on c.code = f.competition_code
    where c.enabled and (
      (f.status = 'scheduled' and f.kickoff_at > now() - interval '3 hours')
      or f.status = 'live'
    )
    order by f.kickoff_at asc limit 1`;
  return rows[0] ?? null;
}

export async function listCompetitions() {
  return sql<{ code: string; name: string; enabled: boolean }[]>`select code, name, enabled from competitions order by enabled desc, name`;
}

export interface FixtureInput {
  competitionCode: string;
  season: string;
  round: string;
  opponent: string;
  venue: 'H' | 'A' | 'N';
  kickoffAt: Date;
  status: FixtureStatus;
}

export function validateFixtureInput(i: Partial<FixtureInput>): string[] {
  const e: string[] = [];
  if (!i.competitionCode) e.push('Choose a competition.');
  if (!i.opponent || i.opponent.trim().length < 2 || i.opponent.length > 60) e.push('Enter the opponent name.');
  if (i.opponent && /arsenal/i.test(i.opponent)) e.push('The opponent cannot be Arsenal.');
  if (!i.venue || !['H', 'A', 'N'].includes(i.venue)) e.push('Choose home, away or neutral.');
  if (!(i.kickoffAt instanceof Date) || isNaN(i.kickoffAt.getTime())) e.push('Enter a valid kickoff date and time.');
  if (!i.status || !FIXTURE_STATUSES.includes(i.status)) e.push('Choose a valid status.');
  if (!i.season || !/^\d{4}-\d{2}$/.test(i.season)) e.push('Season must look like 2026-27.');
  if ((i.round ?? '').length > 40) e.push('Round is too long.');
  return e;
}

export async function createFixture(actor: Actor, i: FixtureInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const errors = validateFixtureInput(i);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  try {
    const id = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into fixtures (competition_code, season, round, opponent, venue, kickoff_at, status, data_source, manual_override)
        values (${i.competitionCode}, ${i.season}, ${i.round.trim()}, ${i.opponent.trim()}, ${i.venue}, ${i.kickoffAt}, ${i.status}, 'manual', true)
        returning id`;
      await audit(tx, actor, 'fixture.created', 'fixture', row.id, { ...i, kickoffAt: i.kickoffAt.toISOString() });
      return row.id;
    });
    return { ok: true, id };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'That fixture already exists (same competition, season, round, opponent and venue).' };
    throw e;
  }
}

export async function updateFixture(actor: Actor, id: string, i: FixtureInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const errors = validateFixtureInput(i);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  try {
    return await sql.begin(async (tx) => {
      const before = await getFixture(id, tx);
      if (!before) return { ok: false as const, error: 'Fixture not found.' };
      if (before.scoringStatus === 'finalised' && (i.status !== 'finished')) {
        return { ok: false as const, error: 'This fixture has been scored. Reopen scoring from the results page before changing its status.' };
      }
      await tx`
        update fixtures set competition_code = ${i.competitionCode}, season = ${i.season}, round = ${i.round.trim()},
          opponent = ${i.opponent.trim()}, venue = ${i.venue}, kickoff_at = ${i.kickoffAt}, status = ${i.status},
          manual_override = true,
          scoring_status = case
            when ${i.status} in ('abandoned', 'cancelled') then 'void'
            when ${i.status} in ('scheduled', 'postponed', 'live') then 'not_ready'
            else scoring_status end,
          updated_at = now()
        where id = ${id}`;
      await audit(tx, actor, 'fixture.updated', 'fixture', id, {
        before: { ...pickFixture(before), kickoffAt: before.kickoffAt.toISOString() },
        after: { ...i, kickoffAt: i.kickoffAt.toISOString() },
      });
      return { ok: true as const };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'Another fixture already has that competition, season, round, opponent and venue.' };
    throw e;
  }
}

function pickFixture(f: Fixture) {
  return { competitionCode: f.competitionCode, season: f.season, round: f.round, opponent: f.opponent, venue: f.venue, status: f.status };
}

export async function setFixtureAutoSync(actor: Actor, id: string, allowSync: boolean) {
  await sql.begin(async (tx) => {
    await tx`update fixtures set manual_override = ${!allowSync}, updated_at = now() where id = ${id}`;
    await audit(tx, actor, allowSync ? 'fixture.sync_enabled' : 'fixture.sync_locked', 'fixture', id, {});
  });
}

// ─── Players ──────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  teamName: string;
  isArsenal: boolean;
  position: string | null;
  shirtNumber: number | null;
  active: boolean;
  provider: string;
}

export interface FixturePlayer extends Player {
  lineupRole: 'starter' | 'substitute' | null;
}

/** Players selectable for a fixture: Arsenal's active squad plus the opponent's (where known). */
export async function playersForFixture(f: Pick<Fixture, 'id' | 'opponent'>, db: Db = sql): Promise<FixturePlayer[]> {
  return db<FixturePlayer[]>`
    select p.id, p.name, p.team_name, p.is_arsenal, p.position, p.shirt_number, p.active, p.provider, l.role as lineup_role
    from players p
    left join fixture_lineups l on l.player_id = p.id and l.fixture_id = ${f.id}
    where p.active and (p.is_arsenal or lower(p.team_name) = lower(${f.opponent}))
    order by p.is_arsenal desc, p.name`;
}

export async function hasLineup(fixtureId: string): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_lineups where fixture_id = ${fixtureId} and role = 'starter'`;
  return r.n >= 11;
}

export async function listPlayers(): Promise<Player[]> {
  return sql<Player[]>`select id, name, team_name, is_arsenal, position, shirt_number, active, provider from players order by is_arsenal desc, team_name, name`;
}

export async function addPlayer(actor: Actor, name: string, teamName: string, position: string | null) {
  const n = name.trim();
  const t = teamName.trim();
  if (n.length < 2 || n.length > 60) return { ok: false as const, error: 'Enter the player name.' };
  if (t.length < 2 || t.length > 60) return { ok: false as const, error: 'Enter the team.' };
  const isArsenal = /^arsenal$/i.test(t);
  try {
    await sql.begin(async (tx) => {
      const [p] = await tx<{ id: string }[]>`
        insert into players (provider, name, team_name, is_arsenal, position)
        values ('manual', ${n}, ${isArsenal ? 'Arsenal' : t}, ${isArsenal}, ${position || null}) returning id`;
      await audit(tx, actor, 'player.created', 'player', p.id, { name: n, team: t });
    });
    return { ok: true as const };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false as const, error: 'That player already exists for that team.' };
    throw e;
  }
}

export async function setPlayerActive(actor: Actor, id: string, active: boolean) {
  await sql.begin(async (tx) => {
    await tx`update players set active = ${active}, updated_at = now() where id = ${id}`;
    await audit(tx, actor, active ? 'player.activated' : 'player.deactivated', 'player', id, {});
  });
}
