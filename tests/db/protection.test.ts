/**
 * Protecting the existing league when the 20-point rules arrive.
 *
 * "Legacy" matches are created exactly as the previous code stored them: point rows with no rules version and no
 * exact-score column, and a successful scoring run whose outcome has no rulesVersion. Every automatic path is then
 * run against them, and the protected data must be byte-for-byte unchanged.
 */
import { resetDatabase } from './helpers';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../../src/lib/db';
import { createFixture } from '../../src/lib/fixtures';
import { savePrediction, adminOverridePrediction } from '../../src/lib/predictions';
import {
  saveManualResult, verifyResult, confirmNameReview, finaliseWithPlayerCategoriesVoid, finaliseFixture,
  rescoreFixture, reopenScoring, applyFeedMatch, getScoringInfo, type ManualResultForm,
} from '../../src/lib/results';
import { addAdjustment } from '../../src/lib/members';
import type { Actor } from '../../src/lib/audit';

let jon: Actor;
const F: Record<string, string> = {};

const member = async (n: string) => (await sql<{ id: string }[]>`select id from members where display_name = ${n}`)[0].id;
function form(ag: number, og: number, scorer: string, assister: string, extra: Partial<ManualResultForm> = {}): ManualResultForm {
  const st = (v: string) => (['none', 'unknown', 'pending'].includes(v) ? (v as 'none') : 'named' as const);
  return { arsenalGoals: ag, opponentGoals: og, scorerState: st(scorer), scorerName: st(scorer) === 'named' ? scorer : '',
    assisterState: st(assister), assisterName: st(assister) === 'named' ? assister : '',
    firstGoalOwnGoal: false, firstGoalUnassisted: false, status: 'finished', notesPrivate: '', publicNote: '', ...extra };
}

async function fixture(opponent: string) {
  const r = await createFixture(jon, { competitionCode: 'PL', season: '2026-27', round: '', opponent, venue: 'H', kickoffAt: new Date(Date.now() + 86400_000), status: 'scheduled' });
  assert.ok(r.ok);
  if (!r.ok) throw new Error();
  return r.id;
}
async function predict(fixtureId: string, who: string, ag: number, og: number, s: string | null, a: string | null) {
  const r = await savePrediction(await member(who), fixtureId, { arsenalGoals: ag, opponentGoals: og, scorer: s, assister: a });
  assert.ok(r.ok);
}
const kickedOff = (id: string) => sql`update fixtures set kickoff_at = now() - interval '3 hours' where id = ${id}`;

/** Store a result and points exactly as the original (15-point) code did. */
async function legacyScore(fixtureId: string, ag: number, og: number, scorer: string, assister: string,
  awards: Record<string, [number, number, number, number, number]>) {
  await sql`update fixtures set status = 'finished', scoring_status = 'finalised' where id = ${fixtureId}`;
  await sql`
    insert into match_results (fixture_id, arsenal_goals, opponent_goals, source, first_scorer_kind, first_scorer_name,
      first_assister_kind, first_assister_name, verified, verified_by, verified_at)
    values (${fixtureId}, ${ag}, ${og}, 'manual', 'player', ${scorer}, 'player', ${assister}, true, ${jon.id}, now())`;
  const [run] = await sql<{ id: string }[]>`
    insert into scoring_runs (fixture_id, triggered_by, trigger, status, outcome, message)
    values (${fixtureId}, ${jon.id}, 'manual_result', 'success',
      ${sql.json({ arsenalGoals: ag, opponentGoals: og, firstScorer: { kind: 'player', id: scorer.toLowerCase() } })}, 'legacy')
    returning id`;
  for (const [who, [sc, as, re, tg, bo]] of Object.entries(awards)) {
    const mid = await member(who);
    const [p] = await sql<{ id: string }[]>`select id from predictions where fixture_id = ${fixtureId} and member_id = ${mid}`;
    await sql`
      insert into fixture_scores (fixture_id, member_id, prediction_id, scorer_points, scorer_outcome, assister_points, assister_outcome,
        result_points, total_goals_points, bonus_points, total_points, scoring_run_id)
      values (${fixtureId}, ${mid}, ${p.id}, ${sc}, ${sc === 5 ? 'correct' : sc === 3 ? 'crossover' : 'incorrect'}, ${as},
        ${as === 5 ? 'correct' : as === 3 ? 'crossover' : 'incorrect'}, ${re}, ${tg}, ${bo}, ${sc + as + re + tg + bo}, ${run.id})`;
  }
}

/** Everything that decides the table and its history, as text, for exact comparison. */
async function protectedState() {
  const q = async (text: TemplateStringsArray) => JSON.stringify(await sql(text));
  return {
    totals: await q`select member_id, display_name, opening_points, match_points, adjustment_points, total_points from member_totals order by member_id`,
    points: await q`select fixture_id, member_id, prediction_id, rules_version, exact_score_points, scorer_points, assister_points,
      result_points, total_goals_points, bonus_points, total_points, scoring_run_id, calculated_at from fixture_scores order by fixture_id, member_id`,
    runs: await q`select id, status from scoring_runs where status = 'success' order by id`,
    statuses: await q`select id, status, scoring_status from fixtures order by id`,
    opening: await q`select member_id, points from opening_balances order by member_id`,
    adjustments: await q`select id, member_id, points, reason from point_adjustments order by id`,
  };
}

before(async () => {
  await resetDatabase();
  jon = { id: await member('Jon'), displayName: 'Jon' };

  // A legacy scored match (15-point rules). James: 2-1 full house = 15. Bob: crossovers 3+3+1+1 = 8.
  F.legacy = await fixture('Chelsea');
  await predict(F.legacy, 'James', 2, 1, 'Saka', 'Odegaard');
  await predict(F.legacy, 'Bob', 2, 1, 'Odegaard', 'Saka');
  await kickedOff(F.legacy);
  await legacyScore(F.legacy, 2, 1, 'Bukayo Saka', 'Martin Ødegaard', { James: [5, 5, 1, 1, 3], Bob: [3, 3, 1, 1, 0] });

  // Legacy match whose points an admin withdrew earlier.
  F.withdrawn = await fixture('Villa');
  await predict(F.withdrawn, 'Steff', 1, 0, 'Saka', null);
  await kickedOff(F.withdrawn);
  await legacyScore(F.withdrawn, 1, 0, 'Bukayo Saka', 'Declan Rice', { Steff: [5, 0, 1, 1, 0] });
  await sql`delete from fixture_scores where fixture_id = ${F.withdrawn}`;
  await sql`update fixtures set scoring_status = 'review_required' where id = ${F.withdrawn}`;

  // Inconsistent: marked finalised by hand, never scored.
  F.ambiguous = await fixture('Wolves');
  await predict(F.ambiguous, 'Ant', 1, 0, 'Saka', 'Rice');
  await kickedOff(F.ambiguous);
  await sql`update fixtures set status = 'finished', scoring_status = 'finalised' where id = ${F.ambiguous}`;

  // A match with predictions, never scored: eligible for the new rules.
  F.fresh = await fixture('Fulham');
  await predict(F.fresh, 'Margaret', 2, 0, 'Saka', 'Rice');
  await predict(F.fresh, 'Charlie', 3, 0, 'Saka', 'Rice');
  await kickedOff(F.fresh);

  await addAdjustment(jon, await member('Tony'), 3, 'Points from the old WhatsApp table', null);
});
after(async () => { await closeDb(); });

describe('How matches are classified', () => {
  test('legacy scored, withdrawn, inconsistent and never-scored matches are told apart', async () => {
    const legacy = await getScoringInfo(sql, F.legacy);
    assert.deepEqual([legacy.state, legacy.rulesVersion], ['scored', 1]);
    const withdrawn = await getScoringInfo(sql, F.withdrawn);
    assert.deepEqual([withdrawn.state, withdrawn.rulesVersion], ['withdrawn', 1]);
    assert.equal((await getScoringInfo(sql, F.ambiguous)).state, 'ambiguous');
    const fresh = await getScoringInfo(sql, F.fresh);
    assert.deepEqual([fresh.state, fresh.rulesVersion], ['fresh', 2]);
  });

  test('legacy totals as stored: James 55+15, Bob 20+8', async () => {
    const t = await sql<{ displayName: string; totalPoints: number }[]>`select display_name, total_points from member_totals where display_name in ('James', 'Bob') order by display_name`;
    assert.deepEqual(t.map((x) => [x.displayName, x.totalPoints]), [['Bob', 28], ['James', 70]]);
  });
});

describe('No automatic path changes an already-scored or inconsistent match', () => {
  test('every automatic path, run three times, leaves all protected data identical', async () => {
    const baseline = await protectedState();
    const feed = { status: 'finished' as const, arsenalGoals: 3, opponentGoals: 3, goals: [], substitutions: [] };
    for (let i = 0; i < 3; i++) {
      for (const id of [F.legacy, F.withdrawn, F.ambiguous]) {
        assert.equal((await finaliseFixture(id, jon, 'test')).status, 'protected');
        assert.equal((await finaliseFixture(id, null, 'cron')).status, 'protected');
        const saved = await saveManualResult(jon, id, form(2, 1, 'Bukayo Saka', 'Martin Ødegaard'));
        assert.ok(saved.ok && saved.finalise?.status === 'protected');
        assert.equal((await verifyResult(jon, id)).status, 'protected');
        assert.equal((await confirmNameReview(jon, id)).status, 'protected');
        assert.match(await applyFeedMatch(id, 'test', feed), /^protected/);
      }
    }
    const after = await protectedState();
    assert.deepEqual(after, baseline);
  });

  test('correcting a legacy result updates the result only; points and table unchanged', async () => {
    const baseline = await protectedState();
    const r = await saveManualResult(jon, F.legacy, form(2, 1, 'Martin Ødegaard', 'Bukayo Saka'));
    assert.ok(r.ok && r.finalise?.status === 'protected');
    const [mr] = await sql<{ firstScorerName: string }[]>`select first_scorer_name from match_results where fixture_id = ${F.legacy}`;
    assert.equal(mr.firstScorerName, 'Martin Ødegaard', 'the correction is saved');
    assert.deepEqual(await protectedState(), baseline, 'no points moved');
    await saveManualResult(jon, F.legacy, form(2, 1, 'Bukayo Saka', 'Martin Ødegaard')); // put it back
  });

  test('re-saving an identical legacy result rewrites nothing, not even timestamps', async () => {
    const row = async () => (await sql<{ r: string }[]>`select row_to_json(m)::text as r from match_results m where fixture_id = ${F.legacy}`)[0].r;
    const audits = async () => (await sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0].n;
    const [before, auditBefore] = [await row(), await audits()];
    const r = await saveManualResult(jon, F.legacy, form(2, 1, 'Bukayo Saka', 'Martin Ødegaard'));
    assert.ok(r.ok && r.finalise?.status === 'protected');
    assert.equal(await row(), before);
    assert.equal(await audits(), auditBefore, 'nothing to audit');
  });

  test('a scored match cannot be switched to live or abandoned from the result form', async () => {
    const baseline = await protectedState();
    for (const status of ['live', 'abandoned'] as const) {
      const r = await saveManualResult(jon, F.legacy, form(2, 1, 'Bukayo Saka', 'Martin Ødegaard', { status }));
      assert.equal(r.ok, false);
    }
    assert.deepEqual(await protectedState(), baseline);
  });

  test('an admin prediction override on a scored match does not rescore it', async () => {
    const baseline = await protectedState();
    const r = await adminOverridePrediction(jon, await member('Bob'), F.legacy,
      { arsenalGoals: 2, opponentGoals: 1, scorer: 'Saka', assister: 'Odegaard' }, 'Bob texted his real picks');
    assert.ok(r.ok && r.needsRescore);
    const after = await protectedState();
    assert.deepEqual(after.points, baseline.points);
    assert.deepEqual(after.totals, baseline.totals);
  });

  test('voiding player picks on a scored match does not rescore it', async () => {
    const baseline = await protectedState();
    const r = await finaliseWithPlayerCategoriesVoid(jon, F.ambiguous, 'Testing the void ruling is protected');
    assert.equal(r.status, 'protected');
    assert.deepEqual(await protectedState(), baseline);
    await sql`update match_results set player_categories_void = false, void_reason = null where fixture_id = ${F.ambiguous}`;
  });
});

describe('Explicit rescoring keeps the original rules', () => {
  test('rescoring a legacy match uses the 15-point rules and reproduces its points exactly', async () => {
    // Bob's prediction was overridden above to the full-house picks, so put it back first.
    await adminOverridePrediction(jon, await member('Bob'), F.legacy,
      { arsenalGoals: 2, opponentGoals: 1, scorer: 'Odegaard', assister: 'Saka' }, 'Restoring the original prediction');
    const before = await sql<{ memberId: string; totalPoints: number }[]>`select member_id, total_points from fixture_scores where fixture_id = ${F.legacy} order by member_id`;
    const r = await rescoreFixture(jon, F.legacy, 'Checking the legacy rules are kept');
    assert.equal(r.status, 'finalised');
    if (r.status === 'finalised') assert.equal(r.rulesVersion, 1);
    const after = await sql<{ memberId: string; totalPoints: number; rulesVersion: number; exactScorePoints: number | null }[]>`
      select member_id, total_points, rules_version, exact_score_points from fixture_scores where fixture_id = ${F.legacy} order by member_id`;
    assert.deepEqual(after.map((x) => [x.memberId, x.totalPoints]), before.map((x) => [x.memberId, x.totalPoints]));
    assert.ok(after.every((x) => x.rulesVersion === 1 && x.exactScorePoints === null), 'no exact-score points on a 15-point match');
  });

  test('a withdrawn legacy match comes back only through an explicit rescore, with 15-point rules', async () => {
    assert.equal((await finaliseFixture(F.withdrawn, jon, 'test')).status, 'protected');
    // An earlier test saved a different result here (correctly without touching points); restore the real one.
    const saved = await saveManualResult(jon, F.withdrawn, form(1, 0, 'Bukayo Saka', 'Declan Rice'));
    assert.ok(saved.ok && saved.finalise?.status === 'protected');
    const r = await rescoreFixture(jon, F.withdrawn, 'Assist confirmed, publishing again');
    assert.equal(r.status, 'finalised');
    const [row] = await sql<{ totalPoints: number; rulesVersion: number }[]>`select total_points, rules_version from fixture_scores where fixture_id = ${F.withdrawn}`;
    assert.deepEqual([row.totalPoints, row.rulesVersion], [7, 1], 'Steff: 1-0 Saka, no assister v Rice → 5+0+1+1 = 7');
  });

  test('rescoring needs an admin and a real reason', async () => {
    assert.equal((await rescoreFixture(jon, F.legacy, 'short')).status, 'error');
    await assert.rejects(rescoreFixture({ id: await member('Bob'), displayName: 'Bob' }, F.legacy, 'Bob wants more points'), /Only an administrator/);
  });
});

describe('Never-scored matches use the 20-point rules', () => {
  test('first scoring of an eligible match uses the new rules; repeating it adds nothing', async () => {
    const r = await saveManualResult(jon, F.fresh, form(2, 0, 'Bukayo Saka', 'Declan Rice'));
    assert.ok(r.ok && r.finalise?.status === 'finalised');
    if (r.ok && r.finalise?.status === 'finalised') assert.equal(r.finalise.rulesVersion, 2);
    const rows = await sql<{ displayName: string; exactScorePoints: number; totalPoints: number; rulesVersion: number }[]>`
      select m.display_name, s.exact_score_points, s.total_points, s.rules_version
      from fixture_scores s join members m on m.id = s.member_id where s.fixture_id = ${F.fresh} order by m.display_name`;
    assert.deepEqual(rows.map((x) => [x.displayName, x.exactScorePoints, x.totalPoints, x.rulesVersion]), [
      ['Charlie', 0, 11, 2],  // 3-0 v 2-0: scorer 5 + assister 5 + result 1
      ['Margaret', 5, 20, 2], // exact 2-0 full house
    ]);
    const snapshot = await protectedState();
    for (let i = 0; i < 3; i++) {
      await saveManualResult(jon, F.fresh, form(2, 0, 'Bukayo Saka', 'Declan Rice'));
      await finaliseFixture(F.fresh, null, 'cron');
    }
    assert.deepEqual(await protectedState(), snapshot, 'no duplicate points');
  });

  test('a never-scored match that is ambiguous on names is held and publishes nothing', async () => {
    const id = await fixture('Leeds');
    await predict(id, 'Neal', 1, 0, 'Gabriel', 'Saka');
    await kickedOff(id);
    const r = await saveManualResult(jon, id, form(1, 0, 'Gabriel Martinelli', 'Gabriel Magalhães'));
    assert.ok(r.ok && r.finalise?.status === 'blocked');
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_scores where fixture_id = ${id}`;
    assert.equal(c.n, 0);
    assert.equal((await getScoringInfo(sql, id)).state, 'fresh', 'still eligible for first scoring once resolved');
  });
});

describe('Balances and adjustments', () => {
  test('opening balances and manual adjustments are never touched by scoring or rescoring', async () => {
    const [o] = await sql<{ total: number; n: number }[]>`select sum(points)::int as total, count(*)::int as n from opening_balances`;
    assert.deepEqual([o.total, o.n], [1012, 32]);
    const adj = await sql<{ points: number; reason: string }[]>`select points, reason from point_adjustments`;
    assert.deepEqual(adj.map((a) => [a.points, a.reason]), [[3, 'Points from the old WhatsApp table']]);
    const [bad] = await sql<{ n: number }[]>`
      select count(*)::int as n from member_totals where total_points <> opening_points + match_points + adjustment_points`;
    assert.equal(bad.n, 0);
  });

  test('withdrawing points is explicit, audited, and records what was removed', async () => {
    await reopenScoring(jon, F.legacy, 'Testing the audit trail of a withdrawal');
    const [a] = await sql<{ details: { removed: unknown[] } }[]>`select details from audit_log where action = 'scoring.reopened' order by id desc limit 1`;
    assert.equal(a.details.removed.length, 2);
  });
});
