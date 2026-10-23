/**
 * Free-text official results: explicit scorer/assister states, name matching, review gating,
 * idempotent re-saves, edits, adjustments and leaderboard consistency.
 */
import { resetDatabase } from './helpers';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../../src/lib/db';
import { createFixture } from '../../src/lib/fixtures';
import { savePrediction } from '../../src/lib/predictions';
import { saveManualResult, confirmNameReview, checkPredictions, type ManualResultForm } from '../../src/lib/results';
import { addAdjustment } from '../../src/lib/members';
import type { Actor } from '../../src/lib/audit';

let jon: Actor;
let fixtureId: string;
const P: Record<string, string> = {};

const member = async (name: string) => (await sql<{ id: string }[]>`select id from members where display_name = ${name}`)[0].id;
const matchPoints = async (name: string) =>
  (await sql<{ matchPoints: number }[]>`select match_points from member_totals where display_name = ${name}`)[0].matchPoints;
const scoreRow = async (name: string) => (await sql<{
  scorerPoints: number; assisterPoints: number; resultPoints: number; totalGoalsPoints: number; bonusPoints: number; totalPoints: number;
  predictedScorer: string; officialScorer: string; officialAssister: string;
}[]>`
  select s.scorer_points, s.assister_points, s.result_points, s.total_goals_points, s.bonus_points, s.total_points,
         s.predicted_scorer, s.official_scorer, s.official_assister
  from fixture_scores s join members m on m.id = s.member_id where s.fixture_id = ${fixtureId} and m.display_name = ${name}`)[0];
const status = async () => (await sql<{ scoringStatus: string; reviewReason: string | null }[]>`select scoring_status, review_reason from fixtures where id = ${fixtureId}`)[0];

function form(ag: number, og: number, scorer: string, assister: string, extra: Partial<ManualResultForm> = {}): ManualResultForm {
  const st = (v: string) => (['none', 'unknown', 'pending'].includes(v) ? (v as 'none' | 'unknown' | 'pending') : 'named' as const);
  return {
    arsenalGoals: ag, opponentGoals: og,
    scorerState: st(scorer), scorerName: st(scorer) === 'named' ? scorer : '',
    assisterState: st(assister), assisterName: st(assister) === 'named' ? assister : '',
    firstGoalOwnGoal: false, firstGoalUnassisted: false, status: 'finished', notesPrivate: '', publicNote: '', ...extra,
  };
}

before(async () => {
  await resetDatabase();
  jon = { id: await member('Jon'), displayName: 'Jon' };
  for (const [name, team] of [['Martin Ødegaard', 'Arsenal'], ['Ben White', 'Arsenal'], ['Kai Havertz', 'Arsenal'], ['Myles Lewis-Skelly', 'Arsenal'], ["Kieran O'Brien", 'Brentford']]) {
    const [p] = await sql<{ id: string }[]>`insert into players (provider, name, team_name, is_arsenal) values ('manual', ${name}, ${team}, ${team === 'Arsenal'}) returning id`;
    P[name] = p.id;
  }
  const f = await createFixture(jon, { competitionCode: 'PL', season: '2026-27', round: '', opponent: 'Brentford', venue: 'H', kickoffAt: new Date(Date.now() + 86400_000), status: 'scheduled' });
  assert.ok(f.ok);
  if (f.ok) fixtureId = f.id;
  const pick = async (who: string, ag: number, og: number, scorer: string, assister: string) =>
    assert.ok((await savePrediction(await member(who), fixtureId, { arsenalGoals: ag, opponentGoals: og, scorer, assister })).ok);
  await pick('Tipple', 2, 1, P['Martin Ødegaard'], P['Ben White']);
  await pick('Henry', 2, 1, P['Ben White'], P['Martin Ødegaard']); // crossover both ways
  await pick('Liam', 1, 1, P['Kai Havertz'], 'none');
  await pick('Gareth', 3, 0, P['Myles Lewis-Skelly'], P["Kieran O'Brien"]);
  await sql`update fixtures set kickoff_at = now() - interval '2 hours' where id = ${fixtureId}`;
});
after(async () => { await closeDb(); });

describe('Explicit scorer/assister states', () => {
  test('assister "not entered yet": result saved, nothing scored, flagged incomplete', async () => {
    const r = await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'pending'));
    assert.ok(r.ok && r.finalise?.status === 'blocked');
    const s = await status();
    assert.equal(s.scoringStatus, 'awaiting_verification');
    assert.match(s.reviewReason!, /assister has not been entered/);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_scores where fixture_id = ${fixtureId}`;
    assert.equal(c.n, 0);
    // Picks are shown as waiting, not as right or wrong.
    const { rows } = await checkPredictions(fixtureId);
    assert.equal(rows.find((x) => x.displayName === 'Tipple')!.assisterVerdict, 'pending');
  });

  test('assister "unknown": also held, with a different reason', async () => {
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'unknown'));
    const s = await status();
    assert.equal(s.scoringStatus, 'awaiting_verification');
    assert.match(s.reviewReason!, /assister is marked unknown/);
    assert.equal(await matchPoints('Tipple'), 0);
  });
});

describe('Typed names are matched reliably', () => {
  test('case and spacing differences still match; breakdown is stored', async () => {
    const r = await saveManualResult(jon, fixtureId, form(2, 1, '  martin   ødegaard ', 'BEN WHITE'));
    assert.ok(r.ok && r.finalise?.status === 'finalised', JSON.stringify(r));
    const t = await scoreRow('Tipple');
    assert.deepEqual([t.scorerPoints, t.assisterPoints, t.resultPoints, t.totalGoalsPoints, t.bonusPoints, t.totalPoints], [5, 5, 1, 1, 3, 15]);
    assert.equal(t.predictedScorer, 'Martin Ødegaard');
    assert.equal(t.officialScorer, 'Martin Ødegaard', 'stored with the proper spelling of the exact match');
    const h = await scoreRow('Henry');
    assert.deepEqual([h.scorerPoints, h.assisterPoints, h.bonusPoints, h.totalPoints], [3, 3, 0, 8], 'both crossovers');
    const l = await scoreRow('Liam');
    assert.equal(l.totalPoints, 0, 'Havertz wrong, "no assister" wrong, 1-1 v 2-1 wrong result and total');
  });

  test('members who did not predict get no score row', async () => {
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_scores where fixture_id = ${fixtureId}`;
    assert.equal(c.n, 4);
  });

  test('saving the same result again does not change anything', async () => {
    const before = await matchPoints('Tipple');
    for (let i = 0; i < 3; i++) await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'Ben White'));
    assert.equal(await matchPoints('Tipple'), before);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_scores where fixture_id = ${fixtureId}`;
    assert.equal(c.n, 4);
  });

  test('apostrophes and hyphens: curly apostrophe and en dash still match exactly', async () => {
    const r = await saveManualResult(jon, fixtureId, form(3, 0, 'Myles Lewis–Skelly', 'Kieran O’Brien'));
    assert.ok(r.ok && r.finalise?.status === 'finalised', JSON.stringify(r));
    const g = await scoreRow('Gareth');
    assert.deepEqual([g.scorerPoints, g.assisterPoints, g.resultPoints, g.totalGoalsPoints, g.bonusPoints], [5, 5, 1, 1, 3]);
  });
});

describe('Near-miss names are flagged, never guessed', () => {
  test('missing accent: scoring is held and earlier points are withdrawn', async () => {
    const r = await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Odegaard', 'Ben White'));
    assert.ok(r.ok && r.finalise?.status === 'blocked');
    const s = await status();
    assert.equal(s.scoringStatus, 'review_required');
    assert.match(s.reviewReason!, /Tipple: "Martin Ødegaard" looks like "Martin Odegaard"/);
    assert.equal(await matchPoints('Tipple'), 0, 'no points while names are unresolved');
    const { rows } = await checkPredictions(fixtureId);
    assert.equal(rows.find((x) => x.displayName === 'Tipple')!.scorerVerdict, 'review');
    assert.equal(rows.find((x) => x.displayName === 'Henry')!.assisterVerdict, 'review');
  });

  test('admin confirms they are different players: only exact matches score', async () => {
    const r = await confirmNameReview(jon, fixtureId);
    assert.equal(r.status, 'finalised');
    const t = await scoreRow('Tipple');
    assert.deepEqual([t.scorerPoints, t.assisterPoints, t.bonusPoints, t.totalPoints], [0, 5, 0, 7]);
    const h = await scoreRow('Henry');
    assert.deepEqual([h.scorerPoints, h.assisterPoints, h.totalPoints], [3, 0, 5]);
  });

  test('correcting the official name re-enables the match and recalculates', async () => {
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'Ben White'));
    assert.equal((await scoreRow('Tipple')).totalPoints, 15);
    const [r] = await sql<{ nameReviewConfirmed: boolean }[]>`select name_review_confirmed from match_results where fixture_id = ${fixtureId}`;
    assert.equal(r.nameReviewConfirmed, false, 'a review decision does not carry over to different names');
  });
});

describe('Confirmed no assist, own goals', () => {
  test('confirmed "no credited assist" scores the "No assister" pick', async () => {
    await saveManualResult(jon, fixtureId, form(1, 0, 'Kai Havertz', 'none', { firstGoalUnassisted: true }));
    const l = await scoreRow('Liam');
    assert.deepEqual([l.scorerPoints, l.assisterPoints, l.resultPoints, l.totalGoalsPoints], [5, 5, 0, 0]);
    assert.equal(l.officialAssister, '(none)');
    const t = await scoreRow('Tipple');
    assert.equal(t.assisterPoints, 0, 'Ben White pick is wrong when there was no assist');
  });

  test('an own goal never credits a named goalscorer', async () => {
    const r = await saveManualResult(jon, fixtureId, form(1, 0, 'none', 'none', { firstGoalOwnGoal: true }));
    assert.ok(r.ok && r.finalise?.status === 'finalised');
    for (const who of ['Tipple', 'Henry', 'Liam', 'Gareth']) assert.equal((await scoreRow(who)).scorerPoints, 0, who);
  });
});

describe('Security and consistency', () => {
  test('a member who is not an admin cannot change the official result', async () => {
    const bob = { id: await member('Bob'), displayName: 'Bob' };
    await assert.rejects(saveManualResult(bob, fixtureId, form(5, 0, 'Kai Havertz', 'none')), /Only an administrator/);
    await assert.rejects(confirmNameReview(bob, fixtureId), /Only an administrator/);
    const [r] = await sql<{ arsenalGoals: number }[]>`select arsenal_goals from match_results where fixture_id = ${fixtureId}`;
    assert.equal(r.arsenalGoals, 1, 'unchanged');
  });

  test('manual adjustments survive result edits', async () => {
    const tipple = await member('Tipple');
    await addAdjustment(jon, tipple, 4, 'Bonus for organising the night out', null);
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'Ben White'));
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Odegaard', 'Ben White')); // review: points withdrawn
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'Ben White'));
    const [t] = await sql<{ openingPoints: number; matchPoints: number; adjustmentPoints: number; totalPoints: number }[]>`
      select opening_points, match_points, adjustment_points, total_points from member_totals where display_name = 'Tipple'`;
    assert.deepEqual(t, { openingPoints: 30, matchPoints: 15, adjustmentPoints: 4, totalPoints: 49 });
  });

  test('leaderboard totals always equal opening + stored fixture scores + adjustments', async () => {
    const [bad] = await sql<{ n: number }[]>`
      select count(*)::int as n from member_totals t
      where t.match_points <> coalesce((select sum(s.total_points) from fixture_scores s join fixtures f on f.id = s.fixture_id
                                        where s.member_id = t.member_id and f.scoring_status = 'finalised'), 0)
         or t.total_points <> t.opening_points + t.match_points + t.adjustment_points`;
    assert.equal(bad.n, 0);
  });

  test('an abandoned match withdraws and awards nothing', async () => {
    await saveManualResult(jon, fixtureId, form(2, 1, 'Martin Ødegaard', 'Ben White', { status: 'abandoned' }));
    assert.equal((await status()).scoringStatus, 'void');
    assert.equal(await matchPoints('Tipple'), 0);
  });
});
