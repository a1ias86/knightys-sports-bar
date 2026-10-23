import { sql, type Db, type Tx } from './db';
import { audit, type Actor } from './audit';
import { getFixture, type FixtureStatus } from './fixtures';
import {
  scorePrediction, isScoreable, validateOutcome, deriveOutcome,
  type MatchOutcome, type FirstPlayer, type GoalEvent, type Pick as PlayerPick,
} from './scoring';

export interface StoredResult {
  fixtureId: string;
  arsenalGoals: number;
  opponentGoals: number;
  source: 'automatic' | 'manual';
  firstScorerKind: 'player' | 'none' | 'unknown';
  firstScorerPlayerId: string | null;
  firstScorerName: string | null;
  firstAssisterKind: 'player' | 'none' | 'unknown';
  firstAssisterPlayerId: string | null;
  firstAssisterName: string | null;
  firstGoalOwnGoal: boolean;
  firstGoalUnassisted: boolean;
  playerCategoriesVoid: boolean;
  voidReason: string | null;
  issues: string[];
  verified: boolean;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  notesPrivate: string | null;
  publicNote: string | null;
  updatedAt: Date;
}

export async function getResult(fixtureId: string, db: Db = sql): Promise<StoredResult | null> {
  const rows = await db<StoredResult[]>`
    select r.fixture_id, r.arsenal_goals, r.opponent_goals, r.source,
      r.first_scorer_kind, r.first_scorer_player_id, sp.name as first_scorer_name,
      r.first_assister_kind, r.first_assister_player_id, ap.name as first_assister_name,
      r.first_goal_own_goal, r.first_goal_unassisted, r.player_categories_void, r.void_reason, r.issues,
      r.verified, r.verified_at, vm.display_name as verified_by_name, r.notes_private, r.public_note, r.updated_at
    from match_results r
    left join players sp on sp.id = r.first_scorer_player_id
    left join players ap on ap.id = r.first_assister_player_id
    left join members vm on vm.id = r.verified_by
    where r.fixture_id = ${fixtureId}`;
  return rows[0] ?? null;
}

function toFirst(kind: string, id: string | null): FirstPlayer {
  if (kind === 'player' && id) return { kind: 'player', id };
  if (kind === 'none') return { kind: 'none' };
  return { kind: 'unknown' };
}

export function outcomeFromResult(r: Pick<StoredResult, 'arsenalGoals' | 'opponentGoals' | 'firstScorerKind' | 'firstScorerPlayerId' | 'firstAssisterKind' | 'firstAssisterPlayerId' | 'firstGoalOwnGoal'>): MatchOutcome {
  return {
    arsenalGoals: r.arsenalGoals,
    opponentGoals: r.opponentGoals,
    firstScorer: toFirst(r.firstScorerKind, r.firstScorerPlayerId),
    firstAssister: toFirst(r.firstAssisterKind, r.firstAssisterPlayerId),
    firstGoalWasOwnGoal: r.firstGoalOwnGoal,
  };
}

function outcomeSignature(o: MatchOutcome): string {
  const f = (p: FirstPlayer) => (p.kind === 'player' ? p.id : p.kind);
  return `${o.arsenalGoals}-${o.opponentGoals}|${f(o.firstScorer)}|${f(o.firstAssister)}|${o.firstGoalWasOwnGoal}`;
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
 */
export async function finaliseFixture(
  fixtureId: string,
  actor: Actor | null,
  trigger: string,
  opts: { confirmReview?: boolean } = {},
): Promise<FinaliseResult> {
  return sql.begin((tx) => finaliseInTx(tx, fixtureId, actor, trigger, opts));
}

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
    if (!isScoreable(outcome)) {
      return block(r.issues.length ? r.issues.join(' ') : 'The first goalscorer or first assister is not known yet.', 'awaiting_verification');
    }
    if (outcome.firstGoalWasOwnGoal && !r.verified && !opts.confirmReview) {
      return block('The first goal was an own goal. An admin must confirm the first qualifying goal before scoring.', 'review_required');
    }
  }

  const preds = await tx<{
    id: string; memberId: string; arsenalGoals: number; opponentGoals: number;
    scorerPlayerId: string | null; scorerNone: boolean; assisterPlayerId: string | null; assisterNone: boolean;
  }[]>`
    select p.id, p.member_id, p.arsenal_goals, p.opponent_goals, p.scorer_player_id, p.scorer_none,
           p.assister_player_id, p.assister_none
    from predictions p where p.fixture_id = ${fixtureId}`;

  const [run] = await tx<{ id: string }[]>`
    insert into scoring_runs (fixture_id, triggered_by, trigger, status, outcome, message)
    values (${fixtureId}, ${actor?.id ?? null}, ${trigger}, 'success', ${tx.json({ ...outcome, playerCategoriesVoid: playerVoid } as never)},
            ${`Scored ${preds.length} prediction(s)`})
    returning id`;

  await tx`delete from fixture_scores where fixture_id = ${fixtureId}`;
  const pick = (id: string | null, none: boolean): PlayerPick => (none || !id ? { kind: 'none' } : { kind: 'player', id });
  for (const p of preds) {
    const b = scorePrediction(
      { arsenalGoals: p.arsenalGoals, opponentGoals: p.opponentGoals, scorer: pick(p.scorerPlayerId, p.scorerNone), assister: pick(p.assisterPlayerId, p.assisterNone) },
      outcome,
      { playerCategoriesVoid: playerVoid },
    );
    await tx`
      insert into fixture_scores (fixture_id, member_id, prediction_id, scorer_points, scorer_outcome, assister_points,
        assister_outcome, result_points, total_goals_points, bonus_points, total_points, scoring_run_id)
      values (${fixtureId}, ${p.memberId}, ${p.id}, ${b.scorerPoints}, ${b.scorerOutcome}, ${b.assisterPoints},
        ${b.assisterOutcome}, ${b.resultPoints}, ${b.totalGoalsPoints}, ${b.bonusPoints}, ${b.totalPoints}, ${run.id})`;
  }
  await tx`update fixtures set scoring_status = 'finalised', review_reason = null, updated_at = now() where id = ${fixtureId}`;
  await audit(tx, actor, f.scoringStatus === 'finalised' ? 'scoring.recalculated' : 'scoring.finalised', 'fixture', fixtureId, {
    trigger, predictions: preds.length, scoringRunId: run.id,
  });
  return { status: 'finalised', scored: preds.length, runId: run.id };
}

/** Recalculate every finalised fixture (e.g. after a rules fix). Each fixture is its own transaction. */
export async function recalculateAll(actor: Actor) {
  const ids = await sql<{ id: string }[]>`select id from fixtures where scoring_status = 'finalised' order by kickoff_at`;
  const out: { fixtureId: string; result: FinaliseResult }[] = [];
  for (const { id } of ids) out.push({ fixtureId: id, result: await finaliseFixture(id, actor, 'recalculate_all') });
  return out;
}

// ─── Manual results ───────────────────────────────────────────

export interface ManualResultForm {
  arsenalGoals: number;
  opponentGoals: number;
  /** player id | 'none' */
  firstScorer: string;
  /** player id | 'none' */
  firstAssister: string;
  firstGoalOwnGoal: boolean;
  firstGoalUnassisted: boolean;
  status: FixtureStatus;
  notesPrivate: string;
  publicNote: string;
}

export function manualOutcome(form: ManualResultForm): MatchOutcome {
  return {
    arsenalGoals: form.arsenalGoals,
    opponentGoals: form.opponentGoals,
    firstScorer: form.firstScorer === 'none' ? { kind: 'none' } : { kind: 'player', id: form.firstScorer },
    firstAssister: form.firstAssister === 'none' ? { kind: 'none' } : { kind: 'player', id: form.firstAssister },
    firstGoalWasOwnGoal: form.firstGoalOwnGoal,
  };
}

/**
 * Admin enters or corrects a result. The admin's entry is treated as verified and always wins over the
 * automatic feed (feed differences are flagged, never applied silently). Uses the same scoring engine.
 */
export async function saveManualResult(actor: Actor, fixtureId: string, form: ManualResultForm): Promise<
  { ok: true; finalise: FinaliseResult | null } | { ok: false; error: string }
> {
  const outcome = manualOutcome(form);
  if (form.status === 'finished') {
    const errors = validateOutcome(outcome);
    if (errors.length) return { ok: false, error: errors.join(' ') };
  }
  if (!['finished', 'abandoned', 'live'].includes(form.status)) {
    return { ok: false, error: 'A result can only be saved for a live, finished or abandoned match.' };
  }
  const ids = [form.firstScorer, form.firstAssister].filter((x) => x !== 'none');
  return sql.begin(async (tx) => {
    const f = await getFixture(fixtureId, tx);
    if (!f) return { ok: false as const, error: 'Fixture not found.' };
    if (ids.length) {
      const rows = await tx`select id from players where id in ${tx(ids)}`;
      if (rows.length !== new Set(ids).size) return { ok: false as const, error: 'Unknown player selected.' };
    }
    const before = await getResult(fixtureId, tx);
    await tx`
      insert into match_results (fixture_id, arsenal_goals, opponent_goals, source,
        first_scorer_kind, first_scorer_player_id, first_assister_kind, first_assister_player_id,
        first_goal_own_goal, first_goal_unassisted, player_categories_void, void_reason, issues,
        verified, verified_by, verified_at, notes_private, public_note, updated_at)
      values (${fixtureId}, ${form.arsenalGoals}, ${form.opponentGoals}, 'manual',
        ${outcome.firstScorer.kind}, ${outcome.firstScorer.kind === 'player' ? outcome.firstScorer.id : null},
        ${outcome.firstAssister.kind}, ${outcome.firstAssister.kind === 'player' ? outcome.firstAssister.id : null},
        ${form.firstGoalOwnGoal}, ${form.firstGoalUnassisted}, false, null, '[]'::jsonb,
        true, ${actor.id}, now(), ${form.notesPrivate || null}, ${form.publicNote || null}, now())
      on conflict (fixture_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals, source = 'manual',
        first_scorer_kind = excluded.first_scorer_kind, first_scorer_player_id = excluded.first_scorer_player_id,
        first_assister_kind = excluded.first_assister_kind, first_assister_player_id = excluded.first_assister_player_id,
        first_goal_own_goal = excluded.first_goal_own_goal, first_goal_unassisted = excluded.first_goal_unassisted,
        player_categories_void = false, void_reason = null, issues = '[]'::jsonb,
        verified = true, verified_by = excluded.verified_by, verified_at = now(),
        notes_private = excluded.notes_private, public_note = excluded.public_note, updated_at = now()`;
    await tx`
      update fixtures set status = ${form.status},
        scoring_status = case when ${form.status} = 'abandoned' then 'void' else scoring_status end,
        updated_at = now()
      where id = ${fixtureId}`;
    await audit(tx, actor, before ? 'result.corrected' : 'result.entered', 'fixture', fixtureId, {
      before: before ? resultSummary(before) : null,
      after: { score: `${form.arsenalGoals}-${form.opponentGoals}`, firstScorer: form.firstScorer, firstAssister: form.firstAssister,
        ownGoal: form.firstGoalOwnGoal, unassisted: form.firstGoalUnassisted, status: form.status },
    });
    let finalise: FinaliseResult | null = null;
    if (form.status === 'finished') finalise = await finaliseInTx(tx, fixtureId, actor, 'manual_result', { confirmReview: true });
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
    const r = await getResult(fixtureId, tx);
    if (!r) return { status: 'error' as const, reason: 'No result to verify.' };
    await tx`update match_results set verified = true, verified_by = ${actor.id}, verified_at = now() where fixture_id = ${fixtureId}`;
    await tx`update feed_results set discrepancy = null where fixture_id = ${fixtureId}`;
    await audit(tx, actor, 'result.verified', 'fixture', fixtureId, resultSummary(r));
    return finaliseInTx(tx, fixtureId, actor, 'admin_verify', { confirmReview: true });
  });
}

/**
 * Documented competition decision for when reliable scorer/assister data does not exist:
 * the goalscorer and assister categories score 0 for everyone; result and total goals still count.
 */
export async function finaliseWithPlayerCategoriesVoid(actor: Actor, fixtureId: string, reason: string) {
  if (!reason || reason.trim().length < 10) return { status: 'error' as const, reason: 'Record a reason of at least 10 characters.' };
  return sql.begin(async (tx) => {
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
      const same = outcomeSignature(outcomeFromResult(existing)) === outcomeSignature(derived.outcome);
      const scoreSame = existing.arsenalGoals === feed.arsenalGoals && existing.opponentGoals === feed.opponentGoals;
      const msg = same ? null : scoreSame && derived.issues.length ? null
        : `Feed differs from the admin-entered result (feed ${feed.arsenalGoals}-${feed.opponentGoals}).`;
      await tx`update feed_results set discrepancy = ${msg} where fixture_id = ${fixtureId}`;
      if (msg) await audit(tx, null, 'result.feed_discrepancy', 'fixture', fixtureId, { message: msg });
      return msg ? 'discrepancy flagged' : 'manual result kept';
    }

    // A finalised fixture is never un-scored because a later feed response is less complete.
    if (existing && f.scoringStatus === 'finalised' && !isScoreable(derived.outcome)) {
      const sameScore = existing.arsenalGoals === feed.arsenalGoals && existing.opponentGoals === feed.opponentGoals;
      const msg = sameScore ? null : `Feed now reports ${feed.arsenalGoals}-${feed.opponentGoals}; check and correct the result if needed.`;
      await tx`update feed_results set discrepancy = ${msg} where fixture_id = ${fixtureId}`;
      if (msg) await audit(tx, null, 'result.feed_discrepancy', 'fixture', fixtureId, { message: msg });
      return msg ? 'discrepancy flagged' : 'kept finalised result';
    }

    const changed = existing ? outcomeSignature(outcomeFromResult(existing)) !== outcomeSignature(derived.outcome) : true;
    const o = derived.outcome;
    await tx`
      insert into match_results (fixture_id, arsenal_goals, opponent_goals, source,
        first_scorer_kind, first_scorer_player_id, first_assister_kind, first_assister_player_id,
        first_goal_own_goal, first_goal_unassisted, issues, verified, updated_at)
      values (${fixtureId}, ${o.arsenalGoals}, ${o.opponentGoals}, 'automatic',
        ${o.firstScorer.kind}, ${o.firstScorer.kind === 'player' ? o.firstScorer.id : null},
        ${o.firstAssister.kind}, ${o.firstAssister.kind === 'player' ? o.firstAssister.id : null},
        ${o.firstGoalWasOwnGoal}, ${goals?.find((g) => g.type === 'goal')?.assist.status === 'unassisted'},
        ${tx.json(derived.issues as never)}, false, now())
      on conflict (fixture_id) do update set
        arsenal_goals = excluded.arsenal_goals, opponent_goals = excluded.opponent_goals,
        first_scorer_kind = excluded.first_scorer_kind, first_scorer_player_id = excluded.first_scorer_player_id,
        first_assister_kind = excluded.first_assister_kind, first_assister_player_id = excluded.first_assister_player_id,
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
  }[]>`
    select s.member_id, m.display_name, s.scorer_points, s.scorer_outcome, s.assister_points, s.assister_outcome,
           s.result_points, s.total_goals_points, s.bonus_points, s.total_points
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
