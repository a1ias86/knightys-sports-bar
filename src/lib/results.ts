import { sql, type Db, type Tx } from './db';
import { audit, type Actor } from './audit';
import { getFixture, type FixtureStatus } from './fixtures';
import {
  scorePrediction, isScoreable, validateOutcome, deriveOutcome, CURRENT_RULES_VERSION, MAX_POINTS,
  type MatchOutcome, type FirstPlayer, type GoalEvent, type Pick as PlayerPick, type RulesVersion,
} from './scoring';
import { cleanName, nameKey, validateName, matchPickToOfficial } from './names';

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
  /** If the official player came on as a substitute: the player they replaced (picks of that player count). */
  firstScorerReplacedName: string | null;
  firstAssisterReplacedName: string | null;
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
      r.first_scorer_replaced_name, r.first_assister_replaced_name,
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
  | 'correct'      // matches the official player for this category (5)
  | 'crossover'    // matches the official player for the OTHER category (3)
  | 'none-correct' // picked "none" and the official answer is "none" (5)
  | 'wrong'
  | 'review'       // fits BOTH official names: needs an admin decision before scoring
  | 'pending';     // official answer not settled yet

export interface PredictionCheck {
  predictionId: string;
  memberId: string;
  displayName: string;
  arsenalGoals: number;
  opponentGoals: number;
  scorerPick: string | null; // as typed by the member (cleaned), or null for "none"
  assisterPick: string | null;
  scorerVerdict: PickVerdict;
  assisterVerdict: PickVerdict;
  /** Set when the pick counted through a close (not exact) match, e.g. 'matched "Bukayo Saka"'. */
  scorerMatchNote: string | null;
  assisterMatchNote: string | null;
  /** Official name the pick was matched to (used for scoring), or null. */
  scorerMatchedTo: string | null;
  assisterMatchedTo: string | null;
  reviewNotes: string[];
}

interface Official { kind: FirstKind; name: string | null; replaced: string | null }

const RANK = { exact: 2, close: 1, none: 0 } as const;

/** Match a pick to an official player, counting the player they replaced as a substitute. */
function matchOfficial(pick: string, o: Official): { m: 'exact' | 'close' | 'none'; viaSub: boolean } {
  if (o.kind !== 'player') return { m: 'none', viaSub: false };
  const direct = matchPickToOfficial(pick, o.name);
  const sub = o.replaced ? matchPickToOfficial(pick, o.replaced) : 'none';
  return RANK[sub] > RANK[direct] ? { m: sub, viaSub: true } : { m: direct, viaSub: false };
}

function describe(o: Official, viaSub: boolean, exact: boolean): string | null {
  if (viaSub) return `picked ${o.replaced}, replaced by ${o.name} (substitution)`;
  return exact ? null : `matched "${o.name}"`;
}

interface Judgement { verdict: PickVerdict; matchedTo: string | null; matchNote: string | null; reviewNote: string | null }

/**
 * Decide what a member's typed pick counts as, matching it ONLY against this match's two official names.
 * Exact matches win; otherwise the closest official name is used; a pick that fits both is flagged.
 */
function judgePick(pick: string | null, own: Official, other: Official, voided: boolean): Judgement {
  const j = (verdict: PickVerdict, matchedTo: string | null = null, matchNote: string | null = null, reviewNote: string | null = null): Judgement =>
    ({ verdict, matchedTo, matchNote, reviewNote });
  if (voided) return j('wrong');
  if (own.kind === 'unknown' || own.kind === 'pending') return j('pending');
  if (pick === null) return j(own.kind === 'none' ? 'none-correct' : 'wrong');
  const a = matchOfficial(pick, own);
  const b = matchOfficial(pick, other);
  const samePlayer = own.kind === 'player' && other.kind === 'player' && nameKey(own.name) === nameKey(other.name);
  if (a.m === 'exact') return j('correct', own.name, describe(own, a.viaSub, true));
  if (b.m === 'exact' && !samePlayer) return j('crossover', other.name, describe(other, b.viaSub, true));
  if (a.m === 'close' && b.m === 'close' && !samePlayer) {
    return j('review', null, null, `"${pick}" could be "${own.name}" or "${other.name}"`);
  }
  if (a.m === 'close') return j('correct', own.name, describe(own, a.viaSub, false));
  if (b.m === 'close') return j('crossover', other.name, describe(other, b.viaSub, false));
  return j('wrong');
}

/** Per-member comparison against the current official result. Used for the admin table and the scoring gate. */
export async function checkPredictions(fixtureId: string, db: Db = sql): Promise<{ result: StoredResult | null; rows: PredictionCheck[] }> {
  const result = await getResult(fixtureId, db);
  const preds = await db<{
    id: string; memberId: string; displayName: string; arsenalGoals: number; opponentGoals: number;
    scorerName: string | null; scorerNone: boolean; assisterName: string | null; assisterNone: boolean;
  }[]>`
    select p.id, p.member_id, m.display_name, p.arsenal_goals, p.opponent_goals,
           coalesce(p.scorer_name, sp.name) as scorer_name, p.scorer_none,
           coalesce(p.assister_name, ap.name) as assister_name, p.assister_none
    from predictions p
    join members m on m.id = p.member_id
    left join players sp on sp.id = p.scorer_player_id
    left join players ap on ap.id = p.assister_player_id
    where p.fixture_id = ${fixtureId}
    order by lower(m.display_name)`;
  const scorer: Official = { kind: result?.firstScorerKind ?? 'pending', name: result?.firstScorerName ?? null, replaced: result?.firstScorerReplacedName ?? null };
  const assister: Official = { kind: result?.firstAssisterKind ?? 'pending', name: result?.firstAssisterName ?? null, replaced: result?.firstAssisterReplacedName ?? null };
  const voided = !!result?.playerCategoriesVoid;
  const reviewed = !!result?.nameReviewConfirmed;
  const rows = preds.map((p) => {
    const scorerPick = p.scorerNone ? null : cleanName(p.scorerName);
    const assisterPick = p.assisterNone ? null : cleanName(p.assisterName);
    const s = judgePick(scorerPick, scorer, assister, voided);
    const a = judgePick(assisterPick, assister, scorer, voided);
    // Once an admin has ruled on ambiguous picks, they score nothing.
    const fix = (v: PickVerdict): PickVerdict => (v === 'review' && reviewed ? 'wrong' : v);
    return {
      predictionId: p.id, memberId: p.memberId, displayName: p.displayName,
      arsenalGoals: p.arsenalGoals, opponentGoals: p.opponentGoals, scorerPick, assisterPick,
      scorerVerdict: fix(s.verdict), assisterVerdict: fix(a.verdict),
      scorerMatchNote: s.matchNote, assisterMatchNote: a.matchNote,
      scorerMatchedTo: s.matchedTo, assisterMatchedTo: a.matchedTo,
      reviewNotes: reviewed ? [] : [s.reviewNote, a.reviewNote].filter((n): n is string => !!n),
    };
  });
  return { result, rows };
}

// ─── Scoring a fixture ────────────────────────────────────────

export type FinaliseResult =
  | { status: 'finalised'; scored: number; runId: string; rulesVersion: RulesVersion }
  | { status: 'blocked'; reason: string; scoringStatus: 'awaiting_verification' | 'review_required' | 'not_ready' | 'void' }
  | { status: 'protected'; reason: string; state: ScoringState };

// ─── Protecting matches that have already been scored ─────────

/**
 * fresh     never scored: no stored points and no successful scoring run. Scored automatically, once, with the
 *           current (20-point) rules.
 * scored    has stored points (or a successful run and is finalised). Protected: never rescored automatically.
 * withdrawn was scored, then its points were withdrawn by an admin. Protected: needs an explicit rescore.
 * ambiguous inconsistent records (e.g. marked finalised with no scoring history). Protected and flagged; left
 *           untouched until an admin decides.
 */
export type ScoringState = 'fresh' | 'scored' | 'withdrawn' | 'ambiguous';

export interface ScoringInfo {
  state: ScoringState;
  /** Rules this match was scored with (protected) or will be scored with (fresh). */
  rulesVersion: RulesVersion;
  pointRows: number;
  successfulRuns: number;
  note: string | null;
}

export async function getScoringInfo(db: Db, fixtureId: string): Promise<ScoringInfo> {
  const [r] = await db<{
    scoringStatus: string; pointRows: number; versions: number; rowVersion: number | null; runs: number; runVersion: number | null;
  }[]>`
    select f.scoring_status,
      (select count(*)::int from fixture_scores s where s.fixture_id = f.id) as point_rows,
      (select count(distinct coalesce(s.rules_version, 1))::int from fixture_scores s where s.fixture_id = f.id) as versions,
      (select max(coalesce(s.rules_version, 1))::int from fixture_scores s where s.fixture_id = f.id) as row_version,
      (select count(*)::int from scoring_runs r where r.fixture_id = f.id and r.status = 'success') as runs,
      (select coalesce((r.outcome->>'rulesVersion')::int, 1) from scoring_runs r
        where r.fixture_id = f.id and r.status = 'success' order by r.created_at desc limit 1) as run_version
    from fixtures f where f.id = ${fixtureId}`;
  if (!r) throw new Error('Fixture not found');
  const v = (n: number | null | undefined): RulesVersion => (n === 2 ? 2 : 1);
  const base = { pointRows: r.pointRows, successfulRuns: r.runs };
  if (r.pointRows > 0) {
    const problems: string[] = [];
    if (r.versions > 1) problems.push('its stored points use a mix of rule versions');
    if (r.runs === 0) problems.push('it has stored points but no scoring history');
    if (r.scoringStatus !== 'finalised') problems.push(`it has stored points but its scoring status is "${r.scoringStatus}", so they aren't counted in the table`);
    return { ...base, state: problems.length ? 'ambiguous' : 'scored', rulesVersion: v(r.rowVersion), note: problems.length ? `Check this match: ${problems.join('; ')}.` : null };
  }
  if (r.runs > 0) {
    return r.scoringStatus === 'finalised'
      ? { ...base, state: 'scored', rulesVersion: v(r.runVersion), note: null }
      : { ...base, state: 'withdrawn', rulesVersion: v(r.runVersion), note: 'Points for this match were withdrawn. Use "Rescore this match" to publish them again.' };
  }
  if (r.scoringStatus === 'finalised') {
    return { ...base, state: 'ambiguous', rulesVersion: CURRENT_RULES_VERSION, note: 'Check this match: it is marked as scored but has no scoring history or points.' };
  }
  return { ...base, state: 'fresh', rulesVersion: CURRENT_RULES_VERSION, note: null };
}

export const PROTECTED_MESSAGE = 'This match has already been scored, so its points were not changed. If they need correcting, use "Rescore this match".';

/**
 * Score every prediction for a fixture and publish the points.
 *
 * mode 'first'    (default; used by saving results, verifying, the data feed): only scores a FRESH fixture,
 *                 with the current rules. For any other fixture it changes nothing and returns 'protected'.
 * mode 'explicit' (the admin "Rescore this match" action, with a recorded reason): replaces this one fixture's
 *                 points, using the rules it was originally scored with.
 *
 * Runs in ONE transaction with the fixture row locked; a failure part-way leaves the table exactly as it was.
 * Opening balances and manual adjustments live in other tables and are never touched.
 */
export async function finaliseFixture(
  fixtureId: string,
  actor: Actor | null,
  trigger: string,
  opts: FinaliseOptions = {},
): Promise<FinaliseResult> {
  return sql.begin((tx) => finaliseInTx(tx, fixtureId, actor, trigger, opts));
}

interface FinaliseOptions { confirmReview?: boolean; mode?: 'first' | 'explicit'; reason?: string }

const NONE_LABEL = '(none)';

async function finaliseInTx(
  tx: Tx, fixtureId: string, actor: Actor | null, trigger: string, opts: FinaliseOptions,
): Promise<FinaliseResult> {
  const mode = opts.mode ?? 'first';
  const [f] = await tx<{ id: string; status: FixtureStatus; scoringStatus: string }[]>`
    select id, status, scoring_status from fixtures where id = ${fixtureId} for update`;
  if (!f) throw new Error('Fixture not found');
  const info = await getScoringInfo(tx, fixtureId);
  if (mode === 'first' && info.state !== 'fresh') {
    return { status: 'protected', reason: info.note ?? PROTECTED_MESSAGE, state: info.state };
  }
  if (mode === 'explicit' && (!actor || !opts.reason || opts.reason.trim().length < 10)) {
    throw new Error('Rescoring a match needs an admin and a reason of at least 10 characters.');
  }
  const rulesVersion = info.rulesVersion;
  const fresh = info.state === 'fresh';

  const block = async (reason: string, scoringStatus: 'awaiting_verification' | 'review_required' | 'not_ready'): Promise<FinaliseResult> => {
    // A match that has already been scored keeps its points and status: blocking never removes them.
    if (fresh) {
      await tx`update fixtures set scoring_status = ${scoringStatus}, review_reason = ${reason}, updated_at = now() where id = ${fixtureId}`;
    }
    await tx`insert into scoring_runs (fixture_id, triggered_by, trigger, status, message) values (${fixtureId}, ${actor?.id ?? null}, ${trigger}, 'blocked', ${reason})`;
    return { status: 'blocked', reason: fresh ? reason : `${reason} Existing points were left unchanged.`, scoringStatus };
  };

  if (f.status === 'abandoned' || f.status === 'cancelled') {
    if (!fresh) return block(`Match is marked ${f.status}. To remove its points, use "Withdraw points".`, 'review_required');
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
    return block(`Some picks match both official players: ${detail}. Decide before scoring.`, 'review_required');
  }

  const before = mode === 'explicit'
    ? await tx<{ memberId: string; totalPoints: number }[]>`select member_id, total_points from fixture_scores where fixture_id = ${fixtureId}`
    : [];

  const [run] = await tx<{ id: string }[]>`
    insert into scoring_runs (fixture_id, triggered_by, trigger, status, outcome, message)
    values (${fixtureId}, ${actor?.id ?? null}, ${trigger}, 'success',
            ${tx.json({ ...outcome, rulesVersion, scorerName: r.firstScorerName, assisterName: r.firstAssisterName, playerCategoriesVoid: playerVoid } as never)},
            ${`Scored ${rows.length} prediction(s) with the ${MAX_POINTS[rulesVersion]}-point rules`})
    returning id`;

  const official = (kind: FirstKind, name: string | null, replaced: string | null) =>
    playerVoid ? '(void)' : kind === 'player' ? cleanName(name) + (replaced ? ` (sub for ${replaced})` : '') : NONE_LABEL;
  // Each pick scores as the official player it was matched to (exactly or closely); unmatched picks keep their own key.
  const pick = (typed: string | null, matchedTo: string | null): PlayerPick =>
    typed === null ? { kind: 'none' } : { kind: 'player', id: nameKey(matchedTo ?? typed) };

  // Fresh fixture: nothing to remove. Explicit rescore: this one fixture's points are replaced, deliberately.
  if (!fresh) await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
  for (const p of rows) {
    const b = scorePrediction(
      { arsenalGoals: p.arsenalGoals, opponentGoals: p.opponentGoals, scorer: pick(p.scorerPick, p.scorerMatchedTo), assister: pick(p.assisterPick, p.assisterMatchedTo) },
      outcome,
      { playerCategoriesVoid: playerVoid, rulesVersion },
    );
    await tx`
      insert into fixture_scores (fixture_id, member_id, prediction_id, rules_version, exact_score_points,
        scorer_points, scorer_outcome, assister_points,
        assister_outcome, result_points, total_goals_points, bonus_points, total_points, scoring_run_id,
        predicted_arsenal_goals, predicted_opponent_goals, predicted_scorer, predicted_assister,
        official_scorer, official_assister, actual_arsenal_goals, actual_opponent_goals)
      values (${fixtureId}, ${p.memberId}, ${p.predictionId}, ${rulesVersion}, ${b.exactScorePoints},
        ${b.scorerPoints}, ${b.scorerOutcome}, ${b.assisterPoints},
        ${b.assisterOutcome}, ${b.resultPoints}, ${b.totalGoalsPoints}, ${b.bonusPoints}, ${b.totalPoints}, ${run.id},
        ${p.arsenalGoals}, ${p.opponentGoals}, ${p.scorerPick ?? NONE_LABEL}, ${p.assisterPick ?? NONE_LABEL},
        ${official(r.firstScorerKind, r.firstScorerName, r.firstScorerReplacedName)}, ${official(r.firstAssisterKind, r.firstAssisterName, r.firstAssisterReplacedName)},
        ${r.arsenalGoals}, ${r.opponentGoals})`;
  }
  await tx`update fixtures set scoring_status = 'finalised', review_reason = null, updated_at = now() where id = ${fixtureId}`;
  if (mode === 'explicit') {
    const after = await tx<{ memberId: string; totalPoints: number }[]>`select member_id, total_points from fixture_scores where fixture_id = ${fixtureId}`;
    const b4 = new Map(before.map((x) => [x.memberId, x.totalPoints]));
    const changes = after.filter((x) => b4.get(x.memberId) !== x.totalPoints).map((x) => ({ memberId: x.memberId, from: b4.get(x.memberId) ?? null, to: x.totalPoints }));
    await audit(tx, actor, 'scoring.rescored_explicitly', 'fixture', fixtureId, {
      reason: opts.reason!.trim(), rulesVersion, previousState: info.state, predictions: rows.length, scoringRunId: run.id, changes,
    });
  } else {
    await audit(tx, actor, 'scoring.finalised', 'fixture', fixtureId, { trigger, rulesVersion, predictions: rows.length, scoringRunId: run.id });
  }
  return { status: 'finalised', scored: rows.length, runId: run.id, rulesVersion };
}

/** The admin "Rescore this match" action: explicit, one fixture, reason recorded, original rules kept. */
export async function rescoreFixture(actor: Actor, fixtureId: string, reason: string): Promise<FinaliseResult | { status: 'error'; reason: string }> {
  if (!reason || reason.trim().length < 10) return { status: 'error', reason: 'Give a reason of at least 10 characters.' };
  return sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    return finaliseInTx(tx, fixtureId, actor, 'admin_rescore', { mode: 'explicit', reason, confirmReview: true });
  });
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
  /** Optional: the named scorer came on as a substitute for this player. */
  scorerReplaced?: string;
  /** Optional: the named assister came on as a substitute for this player. */
  assisterReplaced?: string;
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
  for (const [state, named, replaced, label] of [
    [form.scorerState, form.scorerName, form.scorerReplaced, 'goalscorer'],
    [form.assisterState, form.assisterName, form.assisterReplaced, 'assister'],
  ] as const) {
    if (!cleanName(replaced)) continue;
    if (state !== 'named') { e.push(`"Came on for" only applies when the first ${label} is a named player.`); continue; }
    const m = validateName(replaced, `Substituted player (${label})`);
    if (m) e.push(m);
    else if (nameKey(replaced) === nameKey(named)) e.push(`The first ${label} can't have come on for themselves.`);
  }
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
    await tx`select 1 from fixtures where id = ${fixtureId} for update`;
    const info = await getScoringInfo(tx, fixtureId);
    // An already-scored match: the result can be corrected, but its points and status never change here.
    if (info.state !== 'fresh' && form.status !== 'finished') {
      return { ok: false as const, error: 'This match has already been scored. To mark it live or abandoned, first use "Withdraw points" (its points then come out of the table).' };
    }
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
    const scorerReplaced = scorerName && cleanName(form.scorerReplaced) ? canonical(form.scorerReplaced!) : null;
    const assisterReplaced = assisterName && cleanName(form.assisterReplaced) ? canonical(form.assisterReplaced!) : null;
    const before = await getResult(fixtureId, tx);
    // A name-review confirmation only stays valid while the official names are unchanged.
    const keepReview = !!before?.nameReviewConfirmed
      && nameKey(before.firstScorerName) === nameKey(scorerName) && nameKey(before.firstAssisterName) === nameKey(assisterName)
      && nameKey(before.firstScorerReplacedName) === nameKey(scorerReplaced) && nameKey(before.firstAssisterReplacedName) === nameKey(assisterReplaced);
    const written = await tx<{ fixtureId: string }[]>`
      insert into match_results (fixture_id, arsenal_goals, opponent_goals, source,
        first_scorer_kind, first_scorer_name, first_scorer_player_id, first_assister_kind, first_assister_name, first_assister_player_id,
        first_scorer_replaced_name, first_assister_replaced_name,
        first_goal_own_goal, first_goal_unassisted, player_categories_void, void_reason, name_review_confirmed, issues,
        verified, verified_by, verified_at, notes_private, public_note, updated_at)
      values (${fixtureId}, ${form.arsenalGoals}, ${form.opponentGoals}, 'manual',
        ${toKind(form.scorerState)}, ${scorerName}, null, ${toKind(form.assisterState)}, ${assisterName}, null,
        ${scorerReplaced}, ${assisterReplaced},
        ${form.firstGoalOwnGoal}, ${form.firstGoalUnassisted}, false, null, ${keepReview}, '[]'::jsonb,
        true, ${actor.id}, now(), ${form.notesPrivate || null}, ${form.publicNote || null}, now())
      on conflict (fixture_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals, source = 'manual',
        first_scorer_kind = excluded.first_scorer_kind, first_scorer_name = excluded.first_scorer_name, first_scorer_player_id = null,
        first_assister_kind = excluded.first_assister_kind, first_assister_name = excluded.first_assister_name, first_assister_player_id = null,
        first_scorer_replaced_name = excluded.first_scorer_replaced_name, first_assister_replaced_name = excluded.first_assister_replaced_name,
        first_goal_own_goal = excluded.first_goal_own_goal, first_goal_unassisted = excluded.first_goal_unassisted,
        player_categories_void = false, void_reason = null, name_review_confirmed = excluded.name_review_confirmed, issues = '[]'::jsonb,
        verified = true, verified_by = excluded.verified_by, verified_at = now(),
        notes_private = excluded.notes_private, public_note = excluded.public_note, updated_at = now()
      where (match_results.arsenal_goals, match_results.opponent_goals, match_results.source,
          match_results.first_scorer_kind, match_results.first_scorer_name, match_results.first_scorer_player_id,
          match_results.first_assister_kind, match_results.first_assister_name, match_results.first_assister_player_id,
          match_results.first_scorer_replaced_name, match_results.first_assister_replaced_name,
          match_results.first_goal_own_goal, match_results.first_goal_unassisted, match_results.player_categories_void,
          match_results.void_reason, match_results.name_review_confirmed, match_results.issues, match_results.verified,
          match_results.notes_private, match_results.public_note)
        is distinct from
        (excluded.arsenal_goals, excluded.opponent_goals, excluded.source,
          excluded.first_scorer_kind, excluded.first_scorer_name, excluded.first_scorer_player_id,
          excluded.first_assister_kind, excluded.first_assister_name, excluded.first_assister_player_id,
          excluded.first_scorer_replaced_name, excluded.first_assister_replaced_name,
          excluded.first_goal_own_goal, excluded.first_goal_unassisted, excluded.player_categories_void,
          excluded.void_reason, excluded.name_review_confirmed, excluded.issues, excluded.verified,
          excluded.notes_private, excluded.public_note)
      returning fixture_id`;
    // Saving exactly the same result again is a no-op: nothing is rewritten and nothing is audited.
    // (Only for already-scored matches; an unscored match still goes on to scoring as normal.)
    if (before && written.length === 0 && info.state !== 'fresh') {
      return { ok: true as const, finalise: { status: 'protected' as const, reason: info.note ?? PROTECTED_MESSAGE, state: info.state } };
    }
    if (info.state === 'fresh') {
      await tx`
        update fixtures set status = ${form.status},
          scoring_status = case when ${form.status} = 'abandoned' then 'void' else scoring_status end,
          updated_at = now()
        where id = ${fixtureId}`;
    }
    await audit(tx, actor, before ? 'result.corrected' : 'result.entered', 'fixture', fixtureId, {
      before: before ? resultSummary(before) : null,
      after: {
        score: `${form.arsenalGoals}-${form.opponentGoals}`,
        firstScorer: scorerName ?? form.scorerState, firstAssister: assisterName ?? form.assisterState,
        scorerCameOnFor: scorerReplaced, assisterCameOnFor: assisterReplaced,
        ownGoal: form.firstGoalOwnGoal, unassisted: form.firstGoalUnassisted, status: form.status,
      },
    });
    let finalise: FinaliseResult | null = null;
    // Fresh match: finished → first scoring (current rules); abandoned → void. Scored match: points untouched.
    if (info.state !== 'fresh') finalise = { status: 'protected', reason: info.note ?? PROTECTED_MESSAGE, state: info.state };
    else if (form.status === 'finished' || form.status === 'abandoned') finalise = await finaliseInTx(tx, fixtureId, actor, 'manual_result', { confirmReview: true });
    else if (form.status === 'live') await tx`update fixtures set scoring_status = 'not_ready' where id = ${fixtureId}`;
    return { ok: true as const, finalise };
  });
}

function resultSummary(r: StoredResult) {
  return {
    score: `${r.arsenalGoals}-${r.opponentGoals}`, source: r.source,
    firstScorer: r.firstScorerKind === 'player' ? r.firstScorerName : r.firstScorerKind,
    firstAssister: r.firstAssisterKind === 'player' ? r.firstAssisterName : r.firstAssisterKind,
    scorerCameOnFor: r.firstScorerReplacedName, assisterCameOnFor: r.firstAssisterReplacedName,
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

/**
 * Explicit admin action: withdraw one match's published points (they come out of the table). The match then
 * needs an explicit "Rescore this match" to publish them again, with its original rules.
 */
export async function reopenScoring(actor: Actor, fixtureId: string, reason: string) {
  if (!reason || reason.trim().length < 10) return { ok: false as const, error: 'Give a reason of at least 10 characters.' };
  await sql.begin(async (tx) => {
    await assertAdmin(tx, actor);
    await tx`select 1 from fixtures where id = ${fixtureId} for update`;
    const removed = await tx<{ memberId: string; totalPoints: number }[]>`select member_id, total_points from fixture_scores where fixture_id = ${fixtureId}`;
    await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
    await tx`update fixtures set scoring_status = 'review_required', review_reason = ${'Reopened: ' + reason.trim()}, updated_at = now() where id = ${fixtureId}`;
    await audit(tx, actor, 'scoring.reopened', 'fixture', fixtureId, { reason: reason.trim(), removed });
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
    const info = await getScoringInfo(tx, fixtureId);
    const fresh = info.state === 'fresh';

    // Status changes from the feed (unless an admin has locked this fixture, or it has ever been scored).
    if (fresh && !f.manualOverride && feed.status !== f.status && f.scoringStatus !== 'finalised') {
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
    // Already-scored match: the feed never changes its result or points. Differences are flagged only.
    if (!fresh) {
      const same = !!existing && outcomeSignature(outcomeFromResult(existing)) === outcomeSignature(feedOutcome);
      const scoreSame = !!existing && existing.arsenalGoals === feed.arsenalGoals && existing.opponentGoals === feed.opponentGoals;
      const msg = same || (scoreSame && derived.issues.length) ? null
        : `Feed differs from the result this match was scored with (feed ${feed.arsenalGoals}-${feed.opponentGoals}). Points were not changed.`;
      await tx`update feed_results set discrepancy = ${msg} where fixture_id = ${fixtureId}`;
      if (msg) await audit(tx, null, 'result.feed_discrepancy', 'fixture', fixtureId, { message: msg });
      return msg ? 'protected: discrepancy flagged' : 'protected: unchanged';
    }
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
    exactScorePoints: number | null; rulesVersion: number | null;
  }[]>`
    select s.member_id, m.display_name, s.scorer_points, s.scorer_outcome, s.assister_points, s.assister_outcome,
           s.exact_score_points, s.rules_version,
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
