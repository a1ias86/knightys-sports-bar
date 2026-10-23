import { sql, type Db } from './db';
import { audit, type Actor } from './audit';
import { getFixture, type Fixture } from './fixtures';

export interface PredictionForm {
  arsenalGoals: number;
  opponentGoals: number;
  /** Player id, or 'none'. */
  scorer: string;
  /** Player id, or 'none'. */
  assister: string;
}

export interface StoredPrediction {
  id: string;
  fixtureId: string;
  memberId: string;
  arsenalGoals: number;
  opponentGoals: number;
  scorerPlayerId: string | null;
  scorerNone: boolean;
  scorerName: string | null;
  scorerTeam: string | null;
  assisterPlayerId: string | null;
  assisterNone: boolean;
  assisterName: string | null;
  assisterTeam: string | null;
  submittedAt: Date;
  updatedAt: Date;
  overrideReason: string | null;
  overrideAt: Date | null;
}

const UUID = /^[0-9a-f-]{36}$/i;

export function parseGoals(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 20 ? v : null;
  if (typeof v !== 'string' || !/^\d{1,2}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= 20 ? n : null;
}

export function validatePredictionForm(p: PredictionForm): string[] {
  const e: string[] = [];
  if (parseGoals(p.arsenalGoals) === null) e.push('Arsenal goals must be a whole number from 0 to 20.');
  if (parseGoals(p.opponentGoals) === null) e.push('Opponent goals must be a whole number from 0 to 20.');
  if (p.scorer !== 'none' && !UUID.test(p.scorer)) e.push('Choose a first goalscorer.');
  if (p.assister !== 'none' && !UUID.test(p.assister)) e.push('Choose a first assister.');
  if (p.scorer === 'none' && !(p.arsenalGoals === 0 && p.opponentGoals === 0)) {
    e.push('"No goalscorer" can only be picked with a 0-0 score prediction.');
  }
  return e;
}

/** Check picked players exist, are active and play for Arsenal or this opponent. */
async function validatePlayers(db: Db, f: Fixture, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const rows = await db<{ id: string }[]>`
    select id from players
    where id in ${db(ids)} and active and (is_arsenal or lower(team_name) = lower(${f.opponent}))`;
  const ok = new Set(rows.map((r) => r.id));
  return ids.every((id) => ok.has(id)) ? null : 'One of the chosen players is not available for this match.';
}

const SELECT_PREDICTION = (db: Db) => db`
  p.id, p.fixture_id, p.member_id, p.arsenal_goals, p.opponent_goals,
  p.scorer_player_id, p.scorer_none, sp.name as scorer_name, sp.team_name as scorer_team,
  p.assister_player_id, p.assister_none, ap.name as assister_name, ap.team_name as assister_team,
  p.submitted_at, p.updated_at, p.override_reason, p.override_at`;

export async function getPrediction(fixtureId: string, memberId: string, db: Db = sql): Promise<StoredPrediction | null> {
  const rows = await db<StoredPrediction[]>`
    select ${SELECT_PREDICTION(db)} from predictions p
    left join players sp on sp.id = p.scorer_player_id
    left join players ap on ap.id = p.assister_player_id
    where p.fixture_id = ${fixtureId} and p.member_id = ${memberId}`;
  return rows[0] ?? null;
}

export async function predictionsForFixture(fixtureId: string): Promise<(StoredPrediction & { displayName: string })[]> {
  return sql<(StoredPrediction & { displayName: string })[]>`
    select ${SELECT_PREDICTION(sql)}, m.display_name from predictions p
    join members m on m.id = p.member_id
    left join players sp on sp.id = p.scorer_player_id
    left join players ap on ap.id = p.assister_player_id
    where p.fixture_id = ${fixtureId}
    order by m.display_name`;
}

export type SaveResult = { ok: true; created: boolean } | { ok: false; error: string };

/**
 * Member submits or edits their own prediction.
 * The lock is enforced here using the database clock and the fixture's stored kickoff,
 * inside a transaction that locks the fixture row, so a change to kickoff can't race a save.
 */
export async function savePrediction(memberId: string, fixtureId: string, form: PredictionForm): Promise<SaveResult> {
  const errors = validatePredictionForm(form);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  return sql.begin(async (tx) => {
    const [lock] = await tx<{ open: boolean }[]>`
      select (status = 'scheduled' and kickoff_at > now()) as open
      from fixtures f join competitions c on c.code = f.competition_code
      where f.id = ${fixtureId} and c.enabled
      for share of f`;
    if (!lock) return { ok: false as const, error: 'Fixture not found.' };
    if (!lock.open) return { ok: false as const, error: 'Predictions for this match are locked.' };
    const f = (await getFixture(fixtureId, tx))!;
    const playerError = await validatePlayers(tx, f, [form.scorer, form.assister].filter((x) => x !== 'none'));
    if (playerError) return { ok: false as const, error: playerError };
    const [row] = await tx<{ created: boolean }[]>`
      insert into predictions (fixture_id, member_id, arsenal_goals, opponent_goals,
        scorer_player_id, scorer_none, assister_player_id, assister_none)
      values (${fixtureId}, ${memberId}, ${form.arsenalGoals}, ${form.opponentGoals},
        ${form.scorer === 'none' ? null : form.scorer}, ${form.scorer === 'none'},
        ${form.assister === 'none' ? null : form.assister}, ${form.assister === 'none'})
      on conflict (fixture_id, member_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals,
        scorer_player_id = excluded.scorer_player_id, scorer_none = excluded.scorer_none,
        assister_player_id = excluded.assister_player_id, assister_none = excluded.assister_none,
        updated_at = now()
      returning (xmax = 0) as created`;
    return { ok: true as const, created: row.created };
  });
}

/**
 * Admin action: set a member's prediction after the lock (e.g. a member sent it by text before kickoff
 * but couldn't log in). Always recorded with a reason. Returns whether the fixture needs rescoring.
 */
export async function adminOverridePrediction(
  actor: Actor, memberId: string, fixtureId: string, form: PredictionForm, reason: string,
): Promise<{ ok: true; needsRescore: boolean } | { ok: false; error: string }> {
  const errors = validatePredictionForm(form);
  if (!reason || reason.trim().length < 5) errors.push('Give a reason (at least 5 characters).');
  if (errors.length) return { ok: false, error: errors.join(' ') };
  return sql.begin(async (tx) => {
    const f = await getFixture(fixtureId, tx);
    if (!f) return { ok: false as const, error: 'Fixture not found.' };
    const [m] = await tx`select 1 from members where id = ${memberId}`;
    if (!m) return { ok: false as const, error: 'Member not found.' };
    const playerError = await validatePlayers(tx, f, [form.scorer, form.assister].filter((x) => x !== 'none'));
    if (playerError) return { ok: false as const, error: playerError };
    const before = await getPrediction(fixtureId, memberId, tx);
    await tx`
      insert into predictions (fixture_id, member_id, arsenal_goals, opponent_goals,
        scorer_player_id, scorer_none, assister_player_id, assister_none, override_by, override_reason, override_at)
      values (${fixtureId}, ${memberId}, ${form.arsenalGoals}, ${form.opponentGoals},
        ${form.scorer === 'none' ? null : form.scorer}, ${form.scorer === 'none'},
        ${form.assister === 'none' ? null : form.assister}, ${form.assister === 'none'},
        ${actor.id}, ${reason.trim()}, now())
      on conflict (fixture_id, member_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals,
        scorer_player_id = excluded.scorer_player_id, scorer_none = excluded.scorer_none,
        assister_player_id = excluded.assister_player_id, assister_none = excluded.assister_none,
        override_by = excluded.override_by, override_reason = excluded.override_reason, override_at = now(),
        updated_at = now()`;
    await audit(tx, actor, 'prediction.override', 'prediction', `${fixtureId}:${memberId}`, {
      fixtureId, memberId, reason: reason.trim(),
      before: before ? summarise(before) : null,
      after: form,
    });
    return { ok: true as const, needsRescore: f.scoringStatus === 'finalised' };
  });
}

function summarise(p: StoredPrediction) {
  return {
    score: `${p.arsenalGoals}-${p.opponentGoals}`,
    scorer: p.scorerNone ? 'none' : p.scorerName,
    assister: p.assisterNone ? 'none' : p.assisterName,
  };
}

export async function memberPredictionHistory(memberId: string, limit = 50) {
  return sql<{
    fixtureId: string; opponent: string; venue: string; kickoffAt: Date; competitionName: string; status: string; scoringStatus: string;
    arsenalGoals: number; opponentGoals: number; scorerName: string | null; scorerNone: boolean; assisterName: string | null; assisterNone: boolean;
    resultArsenal: number | null; resultOpponent: number | null; totalPoints: number | null;
  }[]>`
    select f.id as fixture_id, f.opponent, f.venue, f.kickoff_at, c.name as competition_name, f.status, f.scoring_status,
      p.arsenal_goals, p.opponent_goals, sp.name as scorer_name, p.scorer_none, ap.name as assister_name, p.assister_none,
      r.arsenal_goals as result_arsenal, r.opponent_goals as result_opponent,
      case when f.scoring_status = 'finalised' then coalesce(s.total_points, 0) end as total_points
    from predictions p
    join fixtures f on f.id = p.fixture_id
    join competitions c on c.code = f.competition_code
    left join players sp on sp.id = p.scorer_player_id
    left join players ap on ap.id = p.assister_player_id
    left join match_results r on r.fixture_id = f.id
    left join fixture_scores s on s.fixture_id = f.id and s.member_id = p.member_id
    where p.member_id = ${memberId}
    order by f.kickoff_at desc
    limit ${limit}`;
}
