import { sql, type Db, type Tx } from './db';
import { audit, type Actor } from './audit';
import { getFixture, type FixtureStatus } from './fixtures';
import {
  scorePrediction, isScoreable, validateOutcome, deriveOutcome,
  type MatchOutcome, type FirstPlayer, type GoalEvent, type Pick as PlayerPick,
} from './scoring';
import { cleanName, nameKey, validateName, compareNames } from './names';

export type FirstKind = 'player' | 'none' | 'unknown' | 'pending';

export interface StoredResult {
  fixtureId: string;
  arsenalGoals: number;
  opponentGoals: number;
  source: 'automatic' | 'manual';
  firstScorerKind: FirstKind;
  firstScorerPlayerId: string | null;
  firstScorerName: string | null;
  firstAssisterKind: FirstKind;
  firstAssisterPlayerId: string | null;
  firstAssisterName: string | null;
  firstGoalOwnGoal: boolean;
  firstGoalUnassisted: boolean;
  playerCategoriesVoid: boolean;
  voidReason: string | null;
  nameReviewConfirmed: boolean;
  issues: string[];
  verified: boolean;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  notesPrivate: string | null;
  publicNote: string | null;
  updatedAt: Date;
}

export const KIND_LABEL: Record<FirstKind, { scorer: string; assister: string }> = {
  player: { scorer: 'Named player', assister: 'Named player' },
  none: { scorer: 'No qualifying goal', assister: 'Confirmed: no credited assist' },
  unknown: { scorer: 'Unknown (not available)', assister: 'Unknown (not available)' },
  pending: { scorer: 'Not entered yet', assister: 'Not entered yet' },
};

export async function getResult(fixtureId: string, db: Db = sql): Promise<StoredResult | null> {
  const rows = await db<StoredResult[]>`
    select r.fixture_id, r.arsenal_goals, r.opponent_goals, r.source,
      r.first_scorer_kind, r.first_scorer_player_id, coalesce(r.first_scorer_name, sp.name) as first_scorer_name,
      r.first_assister_kind, r.first_assister_player_id, coalesce(r.first_assister_name, ap.name) as first_assister_name,
      r.first_goal_own_goal, r.first_goal_unassisted, r.player_categories_void, r.void_reason, r.name_review_confirmed, r.issues,
      r.verified, r.verified_at, vm.display_name as verified_by_name, r.notes_private, r.public_note, r.updated_at
    from match_results r
    left join players sp on sp.id = r.first_scorer_player_id
    left join players ap on ap.id = r.first_assister_player_id
    left join members vm on vm.id = r.verified_by
    where r.fixture_id = ${fixtureId}`;
  return rows[0] ?? null;
}

/** Official result → scoring outcome. Players are identified by their normalised NAME (nameKey). */
function toFirst(kind: FirstKind, name: string | null): FirstPlayer {
  if (kind === 'player' && nameKey(name)) return { kind: 'player', id: nameKey(name) };
  if (kind === 'none') return { kind: 'none' };
  return { kind: 'unknown' }; // 'unknown' and 'pending' are never scored
}

export function outcomeFromResult(r: Pick<StoredResult, 'arsenalGoals' | 'opponentGoals' | 'firstScorerKind' | 'firstScorerName' | 'firstAssisterKind' | 'firstAssisterName' | 'firstGoalOwnGoal'>): MatchOutcome {
  return {
    arsenalGoals: r.arsenalGoals,
    opponentGoals: r.opponentGoals,
    firstScorer: toFirst(r.firstScorerKind, r.firstScorerName),
    firstAssister: toFirst(r.firstAssisterKind, r.firstAssisterName),
    firstGoalWasOwnGoal: r.firstGoalOwnGoal,
  };
}

function outcomeSignature(o: MatchOutcome): string {
  const f = (p: FirstPlayer) => (p.kind === 'player' ? p.id : p.kind);
  return `${o.arsenalGoals}-${o.opponentGoals}|${f(o.firstScorer)}|${f(o.firstAssister)}|${o.firstGoalWasOwnGoal}`;
}

/** Defence in depth: official results can only be changed by an active admin, whoever calls this code. */
async function assertAdmin(db: Db, actor: Actor) {
  const [m] = await db<{ ok: boolean }[]>`select (role = 'admin' and is_active) as ok from members where id = ${actor.id}`;
  if (!m?.ok) throw new Error('Only an administrator can change official results.');
}

// ─── Comparing predictions with the official result ──────────

export type PickVerdict =
  | 'correct'      // exact name match with the official player for this category (5)
  | 'crossover'    // exact name match with the official player for the OTHER category (3)
  | 'none-correct' // picked "none" and the official answer is "none" (5)
  | 'wrong'
  | 'review'       // near-miss name: needs an admin decision before scoring
  | 'pending';     // official answer not settled yet

export interface PredictionCheck {
  predictionId: string;
  memberId: string;
  displayName: string;
  arsenalGoals: number;
  opponentGoals: number;
  scorerPick: string | null; // player name, or null for "none"
  assisterPick: string | null;
  scorerVerdict: PickVerdict;
  assisterVerdict: PickVerdict;
  reviewNotes: string[];
}

interface Official { kind: FirstKind; name: string | null }

function judgePick(pick: string | null, own: Official, other: Official, voided: boolean): { verdict: PickVerdict; note: string | null } {
  if (voided) return { verdict: 'wrong', note: null };
  if (own.kind === 'unknown' || own.kind === 'pending') return { verdict: 'pending', note: null };
  if (pick === null) return { verdict: own.kind === 'none' ? 'none-correct' : 'wrong', note: null };
  const vsOwn = own.kind === 'player' ? compareNames(pick, own.name) : 'different';
  if (vsOwn === 'exact') return { verdict: 'correct', note: null };
  if (other.kind === 'unknown' || other.kind === 'pending') {
    if (vsOwn === 'probable') return { verdict: 'review', note: `"${pick}" looks like "${own.name}" but isn't an exact match` };
    return { verdict: 'pending', note: null };
  }
  const vsOther = other.kind === 'player' ? compareNames(pick, other.name) : 'different';
  if (vsOwn === 'probable') return { verdict: 'review', note: `"${pick}" looks like "${own.name}" but isn't an exact match` };
  if (vsOther === 'exact') return { verdict: 'crossover', note: null };
  if (vsOther === 'probable') return { verdict: 'review', note: `"${pick}" looks like "${other.name}" but isn't an exact match` };
  return { verdict: 'wrong', note: null };
}

/** Per-member comparison against the current official result. Used for the admin table and the scoring gate. */
export async function checkPredictions(fixtureId: string, db: Db = sql): Promise<{ result: StoredResult | null; rows: PredictionCheck[] }> {
  const result = await getResult(fixtureId, db);
  const preds = await db<{
    id: string; memberId: string; displayName: string; arsenalGoals: number; opponentGoals: number;
    scorerName: string | null; scorerNone: boolean; assisterName: string | null; assisterNone: boolean;
  }[]>`
    select p.id, p.member_id, m.display_name, p.arsenal_goals, p.opponent_goals,
           sp.name as scorer_name, p.scorer_none, ap.name as assister_name, p.assister_none
    from predictions p
    join members m on m.id = p.member_id
    left join players sp on sp.id = p.scorer_player_id
    left join players ap on ap.id = p.assister_player_id
    where p.fixture_id = ${fixtureId}
    order by lower(m.display_name)`;
  const scorer: Official = { kind: result?.firstScorerKind ?? 'pending', name: result?.firstScorerName ?? null };
  const assister: Official = { kind: result?.firstAssisterKind ?? 'pending', name: result?.firstAssisterName ?? null };
  const voided = !!result?.playerCategoriesVoid;
  const reviewed = !!result?.nameReviewConfirmed;
  const rows = preds.map((p) => {
    const scorerPick = p.scorerNone ? null : cleanName(p.scorerName);
    const assisterPick = p.assisterNone ? null : cleanName(p.assisterName);
    const s = judgePick(scorerPick, scorer, assister, voided);
    const a = judgePick(assisterPick, assister, scorer, voided);
    // Once an admin has confirmed the near-misses are different players, they are simply wrong.
    const fix = (v: PickVerdict): PickVerdict => (v === 'review' && reviewed ? 'wrong' : v);
    return {
      predictionId: p.id, memberId: p.memberId, displayName: p.displayName,
      arsenalGoals: p.arsenalGoals, opponentGoals: p.opponentGoals, scorerPick, assisterPick,
      scorerVerdict: fix(s.verdict), assisterVerdict: fix(a.verdict),
      reviewNotes: reviewed ? [] : [s.note, a.note].filter((n): n is string => !!n),
    };
  });
  return { result, rows };
}

// ─── Scoring a fixture ────────────────────────────────────────

export type FinaliseResult =
  | { status: 'finalised'; scored: number; runId: string }
  | { status: 'blocked'; reason: string; scoringStatus: 'awaiting_verification' | 'review_required' | 'not_ready' | 'void' };

/**
 * Score every prediction for a fixture and publish the points.
 *
 * Runs in ONE transaction with the fixture row locked: previous calculated awards for this fixture are
 * deleted and replaced, so running it any number of times gives the same totals (idempotent), and a
 * failure part-way leaves the leaderboard exactly as it was. Opening balances and manual adjustments
 * live in other tables and are never touched.
 *
 * Players are matched by normalised name (see names.ts). A near-miss name blocks scoring until an admin
 * corrects the official name or confirms the names are different players.
 */
export async function finaliseFixture(
  fixtureId: string,
  actor: Actor | null,
  trigger: string,
  opts: { confirmReview?: boolean } = {},
): Promise<FinaliseResult> {
  return sql.begin((tx) => finaliseInTx(tx, fixtureId, actor, trigger, opts));
}

const NONE_LABEL = '(none)';

async function finaliseInTx(
  tx: Tx, fixtureId: string, actor: Actor | null, trigger: string, opts: { confirmReview?: boolean },
): Promise<FinaliseResult> {
  const [f] = await tx<{ id: string; status: FixtureStatus; scoringStatus: string }[]>`
    select id, status, scoring_status from fixtures where id = ${fixtureId} for update`;
  if (!f) throw new Error('Fixture not found');

  const block = async (reason: string, scoringStatus: 'awaiting_verification' | 'review_required' | 'not_ready'): Promise<FinaliseResult> => {
    // Withdraw any previously published points for this fixture: they are no longer reliable.
    await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
    await tx`update fixtures set scoring_status = ${scoringStatus}, review_reason = ${reason}, updated_at = now() where id = ${fixtureId}`;
    await tx`insert into scoring_runs (fixture_id, triggered_by, trigger, status, message) values (${fixtureId}, ${actor?.id ?? null}, ${trigger}, 'blocked', ${reason})`;
    return { status: 'blocked', reason, scoringStatus };
  };

  if (f.status === 'abandoned' || f.status === 'cancelled') {
    await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
    await tx`update fixtures set scoring_status = 'void', updated_at = now() where id = ${fixtureId}`;
    return { status: 'blocked', reason: `Match ${f.status}: no points are awarded.`, scoringStatus: 'void' };
  }
  if (f.status !== 'finished') return block(`Match status is "${f.status}"; only finished matches are scored.`, 'not_ready');
  const r = await getResult(fixtureId, tx);
  if (!r) return block('No result has been entered yet.', 'awaiting_verification');

  const outcome = outcomeFromResult(r);
  const playerVoid = r.playerCategoriesVoid;
  if (!playerVoid) {
    const problems = validateOutcome(outcome);
    if (problems.length) return block(problems.join(' '), 'review_required');
    const waiting: string[] = [];
    if (r.firstScorerKind === 'pending') waiting.push('the first goalscorer has not been entered yet');
    if (r.firstScorerKind === 'unknown') waiting.push('the first goalscorer is marked unknown');
    if (r.firstAssisterKind === 'pending') waiting.push('the first assister has not been entered yet');
    if (r.firstAssisterKind === 'unknown') waiting.push('the first assister is marked unknown');
    if (waiting.length) {
      const why = `Scoring incomplete: ${waiting.join(' and ')}.` + (r.issues.length ? ` ${r.issues.join(' ')}` : '');
      return block(why, 'awaiting_verification');
    }
    if (!isScoreable(outcome)) return block(r.issues.length ? r.issues.join(' ') : 'The result is incomplete.', 'awaiting_verification');
    if (outcome.firstGoalWasOwnGoal && !r.verified && !opts.confirmReview) {
      return block('The first goal was an own goal. An admin must confirm the first qualifying goal before scoring.', 'review_required');
    }
  }

  const { rows } = await checkPredictions(fixtureId, tx);
  const needsReview = rows.filter((x) => x.scorerVerdict === 'review' || x.assisterVerdict === 'review');
  if (needsReview.length) {
    const detail = needsReview.flatMap((x) => x.reviewNotes.map((n) => `${x.displayName}: ${n}`)).join('; ');
    return block(`Player names need checking before scoring. ${detail}. Correct the official name, or confirm they are different players.`, 'review_required');
  }

  const [run] = await tx<{ id: string }[]>`
    insert into scoring_runs (fixture_id, triggered_by, trigger, status, outcome, message)
    values (${fixtureId}, ${actor?.id ?? null}, ${trigger}, 'success',
            ${tx.json({ ...outcome, scorerName: r.firstScorerName, assisterName: r.firstAssisterName, playerCategoriesVoid: playerVoid } as never)},
            ${`Scored ${rows.length} prediction(s)`})
    returning id`;

  const official = (kind: FirstKind, name: string | null) => (playerVoid ? '(void)' : kind === 'player' ? cleanName(name) : NONE_LABEL);
  const pick = (name: string | null): PlayerPick => (name === null ? { kind: 'none' } : { kind: 'player', id: nameKey(name) });

  await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
  for (const p of rows) {
    const b = scorePrediction(
      { arsenalGoals: p.arsenalGoals, opponentGoals: p.opponentGoals, scorer: pick(p.scorerPick), assister: pick(p.assisterPick) },
      outcome,
      { playerCategoriesVoid: playerVoid },
    );
    await tx`
      insert into fixture_scores (fixture_id, member_id, prediction_id, scorer_points, scorer_outcome, assister_points,
        assister_outcome, result_points, total_goals_points, bonus_points, total_points, scoring_run_id,
        predicted_arsenal_goals, predicted_opponent_goals, predicted_scorer, predicted_assister,
        official_scorer, official_assister, actual_arsenal_goals, actual_opponent_goals)
      values (${fixtureId}, ${p.memberId}, ${p.predictionId}, ${b.scorerPoints}, ${b.scorerOutcome}, ${b.assisterPoints},
        ${b.assisterOutcome}, ${b.resultPoints}, ${b.totalGoalsPoints}, ${b.bonusPoints}, ${b.totalPoints}, ${run.id},
        ${p.arsenalGoals}, ${p.opponentGoals}, ${p.scorerPick ?? NONE_LABEL}, ${p.assisterPick ?? NONE_LABEL},
        ${official(r.firstScorerKind, r.firstScorerName)}, ${official(r.firstAssisterKind, r.firstAssisterName)},
        ${r.arsenalGoals}, ${r.opponentGoals})`;
  }
  await tx`update fixtures set scoring_status = 'finalised', review_reason = null, updated_at = now() where id = ${fixtureId}`;
  await audit(tx, actor, f.scoringStatus === 'finalised' ? 'scoring.recalculated' : 'scoring.finalised', 'fixture', fixtureId, {
    trigger, predictions: rows.length, scoringRunId: run.id,
  });
  return { status: 'finalised', scored: rows.length, runId: run.id };
}

/** Recalculate every finalised fixture (e.g. after a rules fix). Each fixture is its own transaction. */
export async function recalculateAll(actor: Actor) {
  const ids = await sql<{ id: string }[]>`select id from fixtures where scoring_status = 'finalised' order by kickoff_at`;
  const out: { fixtureId: string; result: FinaliseResult }[] = [];
  for (const { id } of ids) out.push({ fixtureId: id, result: await finaliseFixture(id, actor, 'recalculate_all') });
  return out;
}

// ─── Manual results ───────────────────────────────────────────

export type EntryState = 'named' | 'none' | 'unknown' | 'pending';

export interface ManualResultForm {
  arsenalGoals: number;
  opponentGoals: number;
  scorerState: EntryState;
  /** Free text; required when scorerState is 'named'. */
  scorerName: string;
  assisterState: EntryState;
  assisterName: string;
  firstGoalOwnGoal: boolean;
  firstGoalUnassisted: boolean;
  status: FixtureStatus;
  notesPrivate: string;
  publicNote: string;
}

const STATES: EntryState[] = ['named', 'none', 'unknown', 'pending'];
const toKind = (s: EntryState): FirstKind => (s === 'named' ? 'player' : s);

/** Server-side validation of the admin result form. Returns a list of problems (empty = valid). */
export function validateManualResult(form: ManualResultForm): string[] {
  const e: string[] = [];
  for (const [v, label] of [[form.arsenalGoals, 'Arsenal goals'], [form.opponentGoals, 'Opponent goals']] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 20) e.push(`${label} must be a whole number from 0 to 20.`);
  }
  if (!STATES.includes(form.scorerState)) e.push('Choose what you know about the first goalscorer.');
  if (!STATES.includes(form.assisterState)) e.push('Choose what you know about the first assister: a named player, confirmed no assist, unknown, or not entered yet.');
  if (form.scorerState === 'named') { const m = validateName(form.scorerName, 'First goalscorer'); if (m) e.push(m); }
  if (form.assisterState === 'named') { const m = validateName(form.assisterName, 'First assister'); if (m) e.push(m); }
  if (!['finished', 'abandoned', 'live'].includes(form.status)) e.push('A result can only be saved for a live, finished or abandoned match.');
  if (e.length) return e;
  const total = form.arsenalGoals + form.opponentGoals;
  if (form.firstGoalOwnGoal && total === 0) e.push('A 0–0 match cannot have an own goal.');
  if (total === 0 && form.scorerState === 'named') e.push('A 0–0 match has no goalscorer: choose "No qualifying goal".');
  if (total === 0 && form.assisterState === 'named') e.push('A 0–0 match has no assister: choose "Confirmed: no credited assist".');
  if (total > 0 && form.scorerState === 'none' && !form.firstGoalOwnGoal) {
    e.push('Goals were scored, so "No qualifying goal" is only possible if every goal was an own goal: tick the own-goal box, or name the scorer.');
  }
  if (form.scorerState === 'none' && form.assisterState === 'named') e.push('There cannot be a credited assist when there was no qualifying goal.');
  return e;
}

export function manualOutcome(form: ManualResultForm): MatchOutcome {
  return outcomeFromResult({
    arsenalGoals: form.arsenalGoals, opponentGoals: form.opponentGoals,
    firstScorerKind: toKind(form.scorerState), firstScorerName: form.scorerState === 'named' ? cleanName(form.scorerName) : null,
    firstAssisterKind: toKind(form.assisterState), firstAssisterName: form.assisterState === 'named' ? cleanName(form.assisterName) : null,
    firstGoalOwnGoal: form.firstGoalOwnGoal,
  });
}

/**
 * Admin enters or corrects a result. The admin's entry is treated as verified and always wins over the
 * automatic feed (feed differences are flagged, never applied silently). Uses the same scoring engine.
 * Saving the same result again changes nothing; editing it recalculates the fixture (replacing, never adding).
 */
export async function saveManualResult(actor: Actor, fixtureId: string, form: ManualResultForm): Promise<
  { ok: true; finalise: FinaliseResult | null } | { ok: false; error: string }
> {
  const errors = validateManualResult(form);
  if (errors.length) return { ok: false, error: errors.join(' ') };
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    const f = await getFixture(fixtureId, tx);
    if (!f) return { ok: false as const, error: 'Fixture not found.' };
    // Store the player's proper spelling when the typed name is an EXACT (case/space-insensitive) match for a
    // known player in this match. Near-misses are left exactly as typed and flagged at scoring time.
    const known = await tx<{ name: string }[]>`
      select name from players where is_arsenal or lower(team_name) = lower(${f.opponent})`;
    const canonical = (typed: string) => {
      const k = nameKey(typed);
      const hits = [...new Set(known.map((p) => cleanName(p.name)).filter((n) => nameKey(n) === k))];
      return hits.length === 1 ? hits[0] : cleanName(typed);
    };
    const scorerName = form.scorerState === 'named' ? canonical(form.scorerName) : null;
    const assisterName = form.assisterState === 'named' ? canonical(form.assisterName) : null;
    const before = await getResult(fixtureId, tx);
    // A name-review confirmation only stays valid while the official names are unchanged.
    const keepReview = !!before?.nameReviewConfirmed
      && nameKey(before.firstScorerName) === nameKey(scorerName) && nameKey(before.firstAssisterName) === nameKey(assisterName);
    await tx`
      insert into match_results (fixture_id, arsenal_goals, opponent_goals, source,
        first_scorer_kind, first_scorer_name, first_scorer_player_id, first_assister_kind, first_assister_name, first_assister_player_id,
        first_goal_own_goal, first_goal_unassisted, player_categories_void, void_reason, name_review_confirmed, issues,
        verified, verified_by, verified_at, notes_private, public_note, updated_at)
      values (${fixtureId}, ${form.arsenalGoals}, ${form.opponentGoals}, 'manual',
        ${toKind(form.scorerState)}, ${scorerName}, null, ${toKind(form.assisterState)}, ${assisterName}, null,
        ${form.firstGoalOwnGoal}, ${form.firstGoalUnassisted}, false, null, ${keepReview}, '[]'::jsonb,
        true, ${actor.id}, now(), ${form.notesPrivate || null}, ${form.publicNote || null}, now())
      on conflict (fixture_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals, source = 'manual',
        first_scorer_kind = excluded.first_scorer_kind, first_scorer_name = excluded.first_scorer_name, first_scorer_player_id = null,
        first_assister_kind = excluded.first_assister_kind, first_assister_name = excluded.first_assister_name, first_assister_player_id = null,
        first_goal_own_goal = excluded.first_goal_own_goal, first_goal_unassisted = excluded.first_goal_unassisted,
        player_categories_void = false, void_reason = null, name_review_confirmed = excluded.name_review_confirmed, issues = '[]'::jsonb,
        verified = true, verified_by = excluded.verified_by, verified_at = now(),
        notes_private = excluded.notes_private, public_note = excluded.public_note, updated_at = now()`;
    await tx`
      update fixtures set status = ${form.status},
        scoring_status = case when ${form.status} = 'abandoned' then 'void' else scoring_status end,
        updated_at = now()
      where id = ${fixtureId}`;
    await audit(tx, actor, before ? 'result.corrected' : 'result.entered', 'fixture', fixtureId, {
      before: before ? resultSummary(before) : null,
      after: {
        score: `${form.arsenalGoals}-${form.opponentGoals}`,
        firstScorer: scorerName ?? form.scorerState, firstAssister: assisterName ?? form.assisterState,
        ownGoal: form.firstGoalOwnGoal, unassisted: form.firstGoalUnassisted, status: form.status,
      },
    });
    let finalise: FinaliseResult | null = null;
    // Finished → score. Abandoned → finaliseInTx voids the fixture and removes any stored awards.
    if (form.status === 'finished' || form.status === 'abandoned') finalise = await finaliseInTx(tx, fixtureId, actor, 'manual_result', { confirmReview: true });
    else if (form.status === 'live') {
      await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
      await tx`update fixtures set scoring_status = 'not_ready' where id = ${fixtureId}`;
    }
    return { ok: true as const, finalise };
  });
}

function resultSummary(r: StoredResult) {
  return {
    score: `${r.arsenalGoals}-${r.opponentGoals}`, source: r.source,
    firstScorer: r.firstScorerKind === 'player' ? r.firstScorerName : r.firstScorerKind,
    firstAssister: r.firstAssisterKind === 'player' ? r.firstAssisterName : r.firstAssisterKind,
    ownGoal: r.firstGoalOwnGoal, void: r.playerCategoriesVoid,
  };
}

/** Admin confirms an automatic result as correct (including an own-goal-first match) and publishes points. */
export async function verifyResult(actor: Actor, fixtureId: string): Promise<FinaliseResult | { status: 'error'; reason: string }> {
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    const r = await getResult(fixtureId, tx);
    if (!r) return { status: 'error' as const, reason: 'No result to verify.' };
    await tx`update match_results set verified = true, verified_by = ${actor.id}, verified_at = now() where fixture_id = ${fixtureId}`;
    await tx`update feed_results set discrepancy = null where fixture_id = ${fixtureId}`;
    await audit(tx, actor, 'result.verified', 'fixture', fixtureId, resultSummary(r));
    return finaliseInTx(tx, fixtureId, actor, 'admin_verify', { confirmReview: true });
  });
}

/**
 * Admin has looked at the near-miss names flagged for this match and confirms they are DIFFERENT players,
 * so only exact name matches score. (If they are the same player, the admin corrects the official name instead.)
 */
export async function confirmNameReview(actor: Actor, fixtureId: string): Promise<FinaliseResult | { status: 'error'; reason: string }> {
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    const before = await checkPredictions(fixtureId, tx);
    if (!before.result) return { status: 'error' as const, reason: 'No result to review.' };
    const notes = before.rows.flatMap((x) => x.reviewNotes.map((n) => `${x.displayName}: ${n}`));
    await tx`update match_results set name_review_confirmed = true, updated_at = now() where fixture_id = ${fixtureId}`;
    await audit(tx, actor, 'result.name_review_confirmed', 'fixture', fixtureId, { decision: 'different players; exact matches only', notes });
    return finaliseInTx(tx, fixtureId, actor, 'admin_name_review', { confirmReview: true });
  });
}

/**
 * Documented competition decision for when reliable scorer/assister data does not exist:
 * the goalscorer and assister categories score 0 for everyone; result and total goals still count.
 */
export async function finaliseWithPlayerCategoriesVoid(actor: Actor, fixtureId: string, reason: string) {
  if (!reason || reason.trim().length < 10) return { status: 'error' as const, reason: 'Record a reason of at least 10 characters.' };
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    const r = await getResult(fixtureId, tx);
    if (!r) return { status: 'error' as const, reason: 'Enter at least the final score first.' };
    await tx`
      update match_results set player_categories_void = true, void_reason = ${reason.trim()},
        verified = true, verified_by = ${actor.id}, verified_at = now(), updated_at = now()
      where fixture_id = ${fixtureId}`;
    await audit(tx, actor, 'result.player_categories_voided', 'fixture', fixtureId, { reason: reason.trim(), ...resultSummary(r) });
    return finaliseInTx(tx, fixtureId, actor, 'admin_void_player_categories', { confirmReview: true });
  });
}

/** Withdraw published points for a fixture (e.g. to correct it). Totals drop back immediately. */
export async function reopenScoring(actor: Actor, fixtureId: string, reason: string) {
  if (!reason || reason.trim().length < 5) return { ok: false as const, error: 'Give a reason.' };
  await sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    await tx`select 1 from fixtures where id = ${fixtureId} for update`;
    await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
    await tx`update fixtures set scoring_status = 'review_required', review_reason = ${'Reopened: ' + reason.trim()}, updated_at = now() where id = ${fixtureId}`;
    await audit(tx, actor, 'scoring.reopened', 'fixture', fixtureId, { reason: reason.trim() });
  });
  return { ok: true as const };
}

// ─── Automatic (feed) results ─────────────────────────────────

export interface FeedGoal {
  /** Provider's event id, or a deterministic key. */
  key: string;
  minute: number | null;
  extraMinute: number | null;
  type: 'goal' | 'own_goal';
  side: 'arsenal' | 'opponent';
  scorerProviderId: string | null;
  scorerName: string | null;
  assistStatus: 'credited' | 'unassisted' | 'unknown';
  assistProviderId: string | null;
  assistName: string | null;
}

export interface FeedSubstitution {
  key: string;
  minute: number | null;
  side: 'arsenal' | 'opponent';
  playerOnName: string | null;
  playerOffName: string | null;
}

export interface FeedMatch {
  status: FixtureStatus;
  arsenalGoals: number | null;
  opponentGoals: number | null;
  /** null = the provider did not supply events (e.g. free tier) */
  goals: FeedGoal[] | null;
  substitutions: FeedSubstitution[];
}

/** Find or create a player row for a provider player, returning our id. */
export async function upsertProviderPlayer(db: Db, provider: string, providerId: string | null, name: string | null, side: 'arsenal' | 'opponent', opponent: string): Promise<string | null> {
  if (!providerId && !name) return null;
  const team = side === 'arsenal' ? 'Arsenal' : opponent;
  if (providerId) {
    const [row] = await db<{ id: string }[]>`
      insert into players (provider, provider_player_id, name, team_name, is_arsenal)
      values (${provider}, ${providerId}, ${name ?? 'Unknown player'}, ${team}, ${side === 'arsenal'})
      on conflict (provider, provider_player_id) where provider_player_id is not null
      do update set name = coalesce(excluded.name, players.name), updated_at = now()
      returning id`;
    return row.id;
  }
  const [row] = await db<{ id: string }[]>`select id from players where lower(name) = lower(${name}) and lower(team_name) = lower(${team}) limit 1`;
  return row?.id ?? null;
}

/**
 * Apply a provider snapshot to a fixture. Never overwrites an admin-verified manual result: differences are
 * flagged for review instead. Finalises automatically only when the data is complete and unambiguous.
 */
export async function applyFeedMatch(fixtureId: string, provider: string, feed: FeedMatch): Promise<string> {
  return sql.begin(async (tx) => {
    const f = await getFixture(fixtureId, tx);
    if (!f) return 'missing fixture';
    await tx`select 1 from fixtures where id = ${fixtureId} for update`;

    // Status changes from the feed (unless an admin has locked this fixture).
    if (!f.manualOverride && feed.status !== f.status && f.scoringStatus !== 'finalised') {
      await tx`update fixtures set status = ${feed.status}, data_source = 'automatic', last_synced_at = now(), updated_at = now() where id = ${fixtureId}`;
      if (feed.status === 'abandoned' || feed.status === 'cancelled') {
        await tx`update fixtures set scoring_status = 'void', review_reason = ${'Feed reports match ' + feed.status} where id = ${fixtureId}`;
        await audit(tx, null, 'fixture.status_from_feed', 'fixture', fixtureId, { from: f.status, to: feed.status });
        return `status ${feed.status}`;
      }
    }
    if (feed.arsenalGoals === null || feed.opponentGoals === null) return 'no score yet';

    // Map feed goals onto our player ids.
    let goals: GoalEvent[] | null = null;
    const eventRows: { key: string; seq: number; minute: number | null; extra: number | null; type: string; side: string; playerId: string | null; playerName: string | null; assistStatus: string; assistId: string | null; assistName: string | null }[] = [];
    if (feed.goals) {
      goals = [];
      const ordered = [...feed.goals].sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999) || (a.extraMinute ?? 0) - (b.extraMinute ?? 0));
      let seq = 0;
      const seen = new Set<string>();
      for (const g of ordered) {
        if (seen.has(g.key)) continue; // duplicate feed event
        seen.add(g.key);
        seq++;
        const scorerSide = g.type === 'own_goal' ? (g.side === 'arsenal' ? 'opponent' : 'arsenal') : g.side;
        const scorerId = await upsertProviderPlayer(tx, provider, g.scorerProviderId, g.scorerName, scorerSide, f.opponent);
        const assistId = g.assistStatus === 'credited' ? await upsertProviderPlayer(tx, provider, g.assistProviderId, g.assistName, g.side, f.opponent) : null;
        const assist = g.assistStatus === 'credited' && assistId ? { status: 'credited' as const, playerId: assistId }
          : g.assistStatus === 'unassisted' ? { status: 'unassisted' as const } : { status: 'unknown' as const };
        goals.push({ seq, type: g.type, side: g.side, scorerId, assist, dedupeKey: g.key });
        eventRows.push({ key: g.key, seq, minute: g.minute, extra: g.extraMinute, type: g.type, side: g.side, playerId: scorerId, playerName: g.scorerName,
          assistStatus: g.type === 'own_goal' ? 'none' : assist.status, assistId: assist.status === 'credited' ? assist.playerId : null, assistName: g.assistName });
      }
    }

    const derived = goals
      ? deriveOutcome(feed.arsenalGoals, feed.opponentGoals, goals)
      : { outcome: { arsenalGoals: feed.arsenalGoals, opponentGoals: feed.opponentGoals, firstScorer: { kind: 'unknown' as const }, firstAssister: { kind: 'unknown' as const }, firstGoalWasOwnGoal: false }, issues: ['The data provider did not supply goal events (scorer/assist data unavailable).'] };
    if (feed.arsenalGoals + feed.opponentGoals === 0 && !goals) {
      derived.outcome.firstScorer = { kind: 'none' };
      derived.outcome.firstAssister = { kind: 'none' };
      derived.issues = [];
    }

    // Convert the feed outcome from our player ids to official NAMES, the same identity manual results use.
    const idToName = new Map<string, string>();
    const ids = [derived.outcome.firstScorer, derived.outcome.firstAssister].flatMap((x) => (x.kind === 'player' ? [x.id] : []));
    if (ids.length) {
      for (const row of await tx<{ id: string; name: string }[]>`select id, name from players where id in ${tx(ids)}`) idToName.set(row.id, cleanName(row.name));
    }
    const named = (x: FirstPlayer): { kind: FirstKind; name: string | null } =>
      x.kind === 'player' ? (idToName.get(x.id) ? { kind: 'player', name: idToName.get(x.id)! } : { kind: 'unknown', name: null }) : { kind: x.kind, name: null };
    const feedScorer = named(derived.outcome.firstScorer);
    const feedAssister = named(derived.outcome.firstAssister);
    const feedOutcome = outcomeFromResult({
      arsenalGoals: feed.arsenalGoals, opponentGoals: feed.opponentGoals,
      firstScorerKind: feedScorer.kind, firstScorerName: feedScorer.name,
      firstAssisterKind: feedAssister.kind, firstAssisterName: feedAssister.name,
      firstGoalOwnGoal: derived.outcome.firstGoalWasOwnGoal,
    });

    await tx`
      insert into feed_results (fixture_id, provider, arsenal_goals, opponent_goals, status, events, fetched_at)
      values (${fixtureId}, ${provider}, ${feed.arsenalGoals}, ${feed.opponentGoals}, ${feed.status}, ${tx.json({ goals: feed.goals, substitutions: feed.substitutions } as never)}, now())
      on conflict (fixture_id) do update set provider = excluded.provider, arsenal_goals = excluded.arsenal_goals,
        opponent_goals = excluded.opponent_goals, status = excluded.status, events = excluded.events, fetched_at = now()`;

    // Store substitutions for the match centre (display only, never used for scoring).
    await tx`delete from match_events where fixture_id = ${fixtureId} and source = 'automatic'`;
    for (const e of eventRows) {
      await tx`
        insert into match_events (fixture_id, source, dedupe_key, seq, minute, extra_minute, event_type, side, player_id, player_name, assist_status, assist_player_id, assist_name)
        values (${fixtureId}, 'automatic', ${e.key}, ${e.seq}, ${e.minute}, ${e.extra}, ${e.type}, ${e.side}, ${e.playerId}, ${e.playerName}, ${e.assistStatus}, ${e.assistId}, ${e.assistName})
        on conflict (fixture_id, source, dedupe_key) do nothing`;
    }
    let subSeq = 1000;
    for (const s of feed.substitutions) {
      await tx`
        insert into match_events (fixture_id, source, dedupe_key, seq, minute, event_type, side, player_name, assist_name, assist_status)
        values (${fixtureId}, 'automatic', ${'sub:' + s.key}, ${subSeq++}, ${s.minute}, 'substitution', ${s.side}, ${s.playerOnName}, ${s.playerOffName}, 'none')
        on conflict (fixture_id, source, dedupe_key) do nothing`;
    }

    const existing = await getResult(fixtureId, tx);
    if (existing && existing.source === 'manual') {
      // Admin data wins. Flag (don't apply) any difference.
      const same = outcomeSignature(outcomeFromResult(existing)) === outcomeSignature(feedOutcome);
      const scoreSame = existing.arsenalGoals === feed.arsenalGoals && existing.opponentGoals === feed.opponentGoals;
      const msg = same ? null : scoreSame && derived.issues.length ? null
        : `Feed differs from the admin-entered result (feed ${feed.arsenalGoals}-${feed.opponentGoals}).`;
      await tx`update feed_results set discrepancy = ${msg} where fixture_id = ${fixtureId}`;
      if (msg) await audit(tx, null, 'result.feed_discrepancy', 'fixture', fixtureId, { message: msg });
      return msg ? 'discrepancy flagged' : 'manual result kept';
    }

    // A finalised fixture is never un-scored because a later feed response is less complete.
    if (existing && f.scoringStatus === 'finalised' && !isScoreable(feedOutcome)) {
      const sameScore = existing.arsenalGoals === feed.arsenalGoals && existing.opponentGoals === feed.opponentGoals;
      const msg = sameScore ? null : `Feed now reports ${feed.arsenalGoals}-${feed.opponentGoals}; check and correct the result if needed.`;
      await tx`update feed_results set discrepancy = ${msg} where fixture_id = ${fixtureId}`;
      if (msg) await audit(tx, null, 'result.feed_discrepancy', 'fixture', fixtureId, { message: msg });
      return msg ? 'discrepancy flagged' : 'kept finalised result';
    }

    const changed = existing ? outcomeSignature(outcomeFromResult(existing)) !== outcomeSignature(feedOutcome) : true;
    const o = feedOutcome;
    const sid = derived.outcome.firstScorer.kind === 'player' && feedScorer.kind === 'player' ? derived.outcome.firstScorer.id : null;
    const aid = derived.outcome.firstAssister.kind === 'player' && feedAssister.kind === 'player' ? derived.outcome.firstAssister.id : null;
    await tx`
      insert into match_results (fixture_id, arsenal_goals, opponent_goals, source,
        first_scorer_kind, first_scorer_name, first_scorer_player_id, first_assister_kind, first_assister_name, first_assister_player_id,
        first_goal_own_goal, first_goal_unassisted, issues, verified, updated_at)
      values (${fixtureId}, ${o.arsenalGoals}, ${o.opponentGoals}, 'automatic',
        ${feedScorer.kind}, ${feedScorer.name}, ${sid},
        ${feedAssister.kind}, ${feedAssister.name}, ${aid},
        ${o.firstGoalWasOwnGoal}, ${goals?.find((g) => g.type === 'goal')?.assist.status === 'unassisted'},
        ${tx.json(derived.issues as never)}, false, now())
      on conflict (fixture_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals,
        first_scorer_kind = excluded.first_scorer_kind, first_scorer_name = excluded.first_scorer_name, first_scorer_player_id = excluded.first_scorer_player_id,
        first_assister_kind = excluded.first_assister_kind, first_assister_name = excluded.first_assister_name, first_assister_player_id = excluded.first_assister_player_id,
        name_review_confirmed = case when ${changed} then false else match_results.name_review_confirmed end,
        first_goal_own_goal = excluded.first_goal_own_goal, first_goal_unassisted = excluded.first_goal_unassisted,
        issues = excluded.issues,
        verified = case when ${changed} then false else match_results.verified end,
        updated_at = now()
      where match_results.source = 'automatic'`;

    const nowStatus = f.manualOverride ? f.status : feed.status;
    if (nowStatus !== 'finished') return 'result stored (match not finished)';
    if (existing && changed && f.scoringStatus === 'finalised') {
      await audit(tx, null, 'result.feed_correction', 'fixture', fixtureId, { before: resultSummary(existing), after: outcomeSignature(o) });
    }
    if (!changed && f.scoringStatus === 'finalised') return 'unchanged';
    const fin = await finaliseInTx(tx, fixtureId, null, existing && changed ? 'feed_correction' : 'cron', {});
    return fin.status === 'finalised' ? `finalised (${fin.scored})` : `held: ${fin.reason}`;
  });
}

// ─── Match centre data ────────────────────────────────────────

export async function fixtureScores(fixtureId: string) {
  return sql<{
    memberId: string; displayName: string; scorerPoints: number; scorerOutcome: string; assisterPoints: number; assisterOutcome: string;
    resultPoints: number; totalGoalsPoints: number; bonusPoints: number; totalPoints: number;
    predictedScorer: string | null; predictedAssister: string | null; officialScorer: string | null; officialAssister: string | null;
  }[]>`
    select s.member_id, m.display_name, s.scorer_points, s.scorer_outcome, s.assister_points, s.assister_outcome,
           s.result_points, s.total_goals_points, s.bonus_points, s.total_points,
           s.predicted_scorer, s.predicted_assister, s.official_scorer, s.official_assister
    from fixture_scores s join members m on m.id = s.member_id
    join fixtures f on f.id = s.fixture_id and f.scoring_status = 'finalised'
    where s.fixture_id = ${fixtureId}`;
}

export async function matchEvents(fixtureId: string) {
  return sql<{ seq: number; minute: number | null; extraMinute: number | null; eventType: string; side: string; playerName: string | null; assistName: string | null; assistStatus: string; source: string }[]>`
    select seq, minute, extra_minute, event_type, side, coalesce(p.name, e.player_name) as player_name,
           coalesce(ap.name, e.assist_name) as assist_name, assist_status, source
    from match_events e
    left join players p on p.id = e.player_id
    left join players ap on ap.id = e.assist_player_id
    where fixture_id = ${fixtureId}
    order by source, seq`;
}

export async function getFeed(fixtureId: string) {
  const rows = await sql<{ provider: string; arsenalGoals: number | null; opponentGoals: number | null; status: string | null; fetchedAt: Date; discrepancy: string | null }[]>`
    select provider, arsenal_goals, opponent_goals, status, fetched_at, discrepancy from feed_results where fixture_id = ${fixtureId}`;
  return rows[0] ?? null;
}
