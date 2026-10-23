import { resetDatabase, runSeedAgain } from './helpers';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../../src/lib/db';
import { attemptLogin, getSessionMember, LIMITS } from '../../src/lib/auth-core';
import { hashPin } from '../../src/lib/pin';
import { issueMissingPins, resetPin, setMemberActive, addAdjustment, addMember } from '../../src/lib/members';
import { bootstrapAdmins, setupAvailable } from '../../src/lib/setup';
import { savePrediction, adminOverridePrediction, getPrediction } from '../../src/lib/predictions';
import { createFixture, updateFixture, type FixtureInput } from '../../src/lib/fixtures';
import {
  saveManualResult, finaliseFixture, applyFeedMatch, verifyResult, finaliseWithPlayerCategoriesVoid,
  reopenScoring, type FeedMatch, type ManualResultForm,
} from '../../src/lib/results';
import { getLeaderboard } from '../../src/lib/leaderboard';
import type { Actor } from '../../src/lib/audit';

let jon: Actor;
let pins: Map<string, string>;
const ids: Record<string, string> = {};
const players: Record<string, string> = {};

async function memberId(name: string) {
  const [m] = await sql<{ id: string }[]>`select id from members where display_name = ${name}`;
  return m.id;
}
async function total(name: string) {
  const [t] = await sql<{ totalPoints: number; openingPoints: number; matchPoints: number; adjustmentPoints: number }[]>`
    select total_points, opening_points, match_points, adjustment_points from member_totals where display_name = ${name}`;
  return t;
}
function fixtureInput(opponent: string, kickoffAt: Date, round = ''): FixtureInput {
  return { competitionCode: 'PL', season: '2026-27', round, opponent, venue: 'H', kickoffAt, status: 'scheduled' };
}
const inHours = (h: number) => new Date(Date.now() + h * 3600_000);
async function makePlayer(name: string, team: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into players (provider, provider_player_id, name, team_name, is_arsenal)
    values ('test', ${name}, ${name}, ${team}, ${team === 'Arsenal'}) returning id`;
  return p.id;
}
async function kickoffNow(fixtureId: string, status = 'finished') {
  await sql`update fixtures set kickoff_at = now() - interval '2 hours', status = ${status} where id = ${fixtureId}`;
}
/** scorer/assister: a typed name, or 'none' (confirmed none), 'unknown', 'pending'. */
function manual(ag: number, og: number, scorer: string, assister: string, extra: Partial<ManualResultForm> = {}): ManualResultForm {
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
  jon = { id: await memberId('Jon'), displayName: 'Jon' };
  for (const [n, t] of [['Saka', 'Arsenal'], ['Odegaard', 'Arsenal'], ['Rice', 'Arsenal'], ['Havertz', 'Arsenal'], ['Salah', 'Liverpool'], ['OppDefender', 'Chelsea']] as const) {
    players[n] = await makePlayer(n, t);
  }
});
after(async () => { await closeDb(); });

describe('Seed and opening standings', () => {
  test('32 members, Jon and Knighty are admins, opening balances exact', async () => {
    const [c] = await sql<{ n: number; admins: string[] }[]>`
      select count(*)::int as n, array_agg(display_name order by display_name) filter (where role = 'admin') as admins from members`;
    assert.equal(c.n, 32);
    assert.deepEqual(c.admins, ['Jon', 'Knighty']);
    assert.equal((await total('James')).totalPoints, 55);
    assert.equal((await total('Jake')).totalPoints, 1);
    assert.equal((await total('Mark D')).openingPoints, 33);
  });

  test('re-running the seed changes nothing', async () => {
    await sql`update opening_balances set points = 99 where member_id = ${await memberId('Tony')}`;
    await runSeedAgain();
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from members`;
    assert.equal(c.n, 32);
    assert.equal((await total('Tony')).openingPoints, 99, 'seed must not overwrite an existing balance');
    await sql`update opening_balances set points = 18 where member_id = ${await memberId('Tony')}`;
  });

  test('leaderboard positions use competition ranking and match the imported table', async () => {
    const board = await getLeaderboard();
    const pos = Object.fromEntries(board.map((r) => [r.displayName, r.position]));
    const expected: Record<string, number> = {
      James: 1, Margaret: 2, Jon: 3, Steff: 4, Charlie: 5, Roxy: 5, Brett: 7, Prudy: 8, Jackson: 8, Neal: 8, Austin: 11,
      Ross: 12, Knighty: 12, Nadav: 14, Geoff: 15, 'Mark D': 15, 'Mark P': 17, Liam: 18, Henry: 18, Brooksy: 18, Tipple: 18,
      Gareth: 22, Mike: 23, Taraq: 24, Tesh: 25, Naythan: 25, Bob: 27, Greg: 28, Tony: 28, Ant: 30, 'Marc T': 31, Jake: 32,
    };
    assert.deepEqual(pos, expected);
  });
});

describe('Admin setup and PINs', () => {
  test('bootstrap issues admin PINs once only', async () => {
    assert.equal(await setupAvailable(), true);
    const issued = await bootstrapAdmins('test');
    assert.deepEqual(issued!.map((i) => i.displayName), ['Jon', 'Knighty']);
    assert.ok(issued!.every((i) => /^\d{4}$/.test(i.pin)));
    assert.equal(await setupAvailable(), false);
    assert.equal(await bootstrapAdmins('test'), null);
    pins = new Map(issued!.map((i) => [i.displayName, i.pin]));
  });

  test('issue missing PINs: all unique, only hashes stored', async () => {
    const issued = await issueMissingPins(jon);
    assert.equal(issued.length, 30);
    for (const i of issued) pins.set(i.displayName, i.pin);
    assert.equal(new Set(pins.values()).size, 32);
    const rows = await sql<{ pinHash: string }[]>`select pin_hash from members`;
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.pinHash)));
    assert.ok(!rows.some((r) => [...pins.values()].includes(r.pinHash)));
    // Second run issues nothing (does not reset anyone's PIN).
    assert.equal((await issueMissingPins(jon)).length, 0);
  });

  test('database rejects a duplicate PIN', async () => {
    const h = hashPin(pins.get('Bob')!);
    await assert.rejects(sql`update members set pin_hash = ${h} where display_name = 'Tony'`);
  });

  test('PINs never appear in the audit log', async () => {
    const rows = await sql<{ details: unknown }[]>`select details from audit_log`;
    const text = JSON.stringify(rows);
    for (const pin of pins.values()) assert.ok(!new RegExp(`"${pin}"`).test(text));
  });
});

describe('Login and brute-force protection', () => {
  test('correct name + PIN logs in and gives a working session', async () => {
    const r = await attemptLogin(await memberId('Bob'), pins.get('Bob')!, '10.0.0.1', 'test', { delay: false });
    assert.ok(r.ok);
    if (r.ok) {
      const s = await getSessionMember(r.token);
      assert.equal(s?.displayName, 'Bob');
      assert.equal(s?.role, 'member');
    }
  });

  test('wrong PIN fails with a generic message', async () => {
    const r = await attemptLogin(await memberId('Bob'), '0001' === pins.get('Bob') ? '0002' : '0001', '10.0.0.2', null, { delay: false });
    assert.equal(r.ok, false);
  });

  test('5 wrong PINs lock the member; even the right PIN is refused while locked', async () => {
    const id = await memberId('Greg');
    const wrong = pins.get('Greg') === '9998' ? '9997' : '9998';
    for (let i = 0; i < LIMITS.memberFailuresBeforeLock; i++) {
      await attemptLogin(id, wrong, `10.1.0.${i}`, null, { delay: false });
    }
    const r = await attemptLogin(id, pins.get('Greg')!, '10.1.1.1', null, { delay: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Try again/);
  });

  test('an IP address is blocked after repeated failures across members', async () => {
    const ip = '10.9.9.9';
    const names = ['Ant', 'Tesh', 'Liam', 'Henry', 'Mike', 'Gareth', 'Ross', 'Steff', 'Neal', 'Austin'];
    for (const n of names) await attemptLogin(await memberId(n), pins.get(n) === '5550' ? '5551' : '5550', ip, null, { delay: false });
    const r = await attemptLogin(await memberId('Tipple'), pins.get('Tipple')!, ip, null, { delay: false });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /this device/);
  });

  test('inactive members cannot log in and lose their sessions', async () => {
    const id = await memberId('Jake');
    const r = await attemptLogin(id, pins.get('Jake')!, '10.2.0.1', null, { delay: false });
    assert.ok(r.ok);
    await setMemberActive(jon, id, false);
    if (r.ok) assert.equal(await getSessionMember(r.token), null);
    const r2 = await attemptLogin(id, pins.get('Jake')!, '10.2.0.2', null, { delay: false });
    assert.equal(r2.ok, false);
    await setMemberActive(jon, id, true);
  });

  test('PIN reset revokes old sessions and the old PIN stops working', async () => {
    const id = await memberId('Margaret');
    const r = await attemptLogin(id, pins.get('Margaret')!, '10.3.0.1', null, { delay: false });
    assert.ok(r.ok);
    const issued = await resetPin(jon, id);
    if (r.ok) assert.equal(await getSessionMember(r.token), null);
    if (issued.pin !== pins.get('Margaret')) {
      assert.equal((await attemptLogin(id, pins.get('Margaret')!, '10.3.0.2', null, { delay: false })).ok, false);
    }
    assert.ok((await attemptLogin(id, issued.pin, '10.3.0.3', null, { delay: false })).ok);
    pins.set('Margaret', issued.pin);
  });

  test('a forged / random session token is rejected', async () => {
    assert.equal(await getSessionMember('x'.repeat(43)), null);
  });
});

describe('Predictions and locking', () => {
  test('member can submit, then edit (same record, first submission time kept)', async () => {
    const r = await createFixture(jon, fixtureInput('Liverpool', inHours(48)));
    assert.ok(r.ok);
    if (r.ok) ids.liverpool = r.id;
    const bob = await memberId('Bob');
    const s1 = await savePrediction(bob, ids.liverpool, { arsenalGoals: 2, opponentGoals: 1, scorer: players.Saka, assister: players.Odegaard });
    assert.deepEqual(s1, { ok: true, created: true });
    const first = await getPrediction(ids.liverpool, bob);
    const s2 = await savePrediction(bob, ids.liverpool, { arsenalGoals: 3, opponentGoals: 1, scorer: players.Salah, assister: 'none' });
    assert.deepEqual(s2, { ok: true, created: false });
    const second = await getPrediction(ids.liverpool, bob);
    assert.equal(second!.arsenalGoals, 3);
    assert.equal(second!.scorerName, 'Salah');
    assert.equal(second!.assisterNone, true);
    assert.equal(second!.submittedAt.getTime(), first!.submittedAt.getTime());
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from predictions where fixture_id = ${ids.liverpool} and member_id = ${bob}`;
    assert.equal(c.n, 1);
  });

  test('invalid predictions are rejected', async () => {
    const bob = await memberId('Bob');
    assert.equal((await savePrediction(bob, ids.liverpool, { arsenalGoals: -1, opponentGoals: 0, scorer: 'none', assister: 'none' })).ok, false);
    assert.equal((await savePrediction(bob, ids.liverpool, { arsenalGoals: 1, opponentGoals: 0, scorer: 'none', assister: 'none' })).ok, false, '"none" scorer needs 0-0');
    const r = await savePrediction(bob, ids.liverpool, { arsenalGoals: 1, opponentGoals: 0, scorer: players.OppDefender, assister: 'none' });
    assert.equal(r.ok, false, 'Chelsea player not in this match');
  });

  test('predictions lock at the stored kickoff time', async () => {
    const r = await createFixture(jon, fixtureInput('Chelsea', inHours(1)));
    assert.ok(r.ok);
    if (!r.ok) return;
    ids.chelsea = r.id;
    const ant = await memberId('Ant');
    assert.ok((await savePrediction(ant, r.id, { arsenalGoals: 1, opponentGoals: 0, scorer: players.Saka, assister: players.Rice })).ok);
    await sql`update fixtures set kickoff_at = now() - interval '1 second' where id = ${r.id}`;
    const late = await savePrediction(ant, r.id, { arsenalGoals: 5, opponentGoals: 0, scorer: players.Havertz, assister: players.Rice });
    assert.deepEqual(late, { ok: false, error: 'Predictions for this match are locked.' });
    assert.equal((await getPrediction(r.id, ant))!.arsenalGoals, 1, 'locked value preserved');
  });

  test('postponed matches are closed; rescheduling reopens with the new deadline', async () => {
    const r = await createFixture(jon, fixtureInput('Everton', inHours(5)));
    assert.ok(r.ok);
    if (!r.ok) return;
    const tesh = await memberId('Tesh');
    await updateFixture(jon, r.id, { ...fixtureInput('Everton', inHours(5)), status: 'postponed' });
    assert.equal((await savePrediction(tesh, r.id, { arsenalGoals: 1, opponentGoals: 0, scorer: players.Saka, assister: 'none' })).ok, false);
    await updateFixture(jon, r.id, fixtureInput('Everton', inHours(24 * 10)));
    assert.ok((await savePrediction(tesh, r.id, { arsenalGoals: 1, opponentGoals: 0, scorer: players.Saka, assister: 'none' })).ok);
  });

  test('duplicate fixtures are refused', async () => {
    const r = await createFixture(jon, fixtureInput('Liverpool', inHours(72)));
    assert.equal(r.ok, false);
  });

  test('admin override after the lock is recorded with a reason', async () => {
    const steff = await memberId('Steff');
    const bad = await adminOverridePrediction(jon, steff, ids.chelsea, { arsenalGoals: 2, opponentGoals: 0, scorer: players.Saka, assister: players.Rice }, '');
    assert.equal(bad.ok, false);
    const ok = await adminOverridePrediction(jon, steff, ids.chelsea, { arsenalGoals: 2, opponentGoals: 0, scorer: players.Saka, assister: players.Rice }, 'Sent by text before kickoff');
    assert.ok(ok.ok);
    const p = await getPrediction(ids.chelsea, steff);
    assert.equal(p!.overrideReason, 'Sent by text before kickoff');
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'prediction.override'`;
    assert.equal(a.n, 1);
  });
});

describe('Scoring persistence', () => {
  test('manual result scores predictions and updates the leaderboard', async () => {
    await kickoffNow(ids.chelsea, 'live');
    const antBefore = (await total('Ant')).totalPoints; // 17
    const steffBefore = (await total('Steff')).totalPoints; // 48
    const r = await saveManualResult(jon, ids.chelsea, manual(1, 0, 'Saka', 'Rice'));
    assert.ok(r.ok && r.finalise?.status === 'finalised');
    // Ant: 1-0, Saka, Rice -> 15 (full house)
    assert.equal((await total('Ant')).totalPoints, antBefore + 15);
    // Steff: 2-0, Saka, Rice -> 5+5+1 = 11 (total wrong)
    assert.equal((await total('Steff')).totalPoints, steffBefore + 11);
    const t = await total('Ant');
    assert.equal(t.totalPoints, t.openingPoints + t.matchPoints + t.adjustmentPoints);
  });

  test('recalculating repeatedly never duplicates points', async () => {
    const before = await total('Ant');
    for (let i = 0; i < 3; i++) await finaliseFixture(ids.chelsea, jon, 'test');
    assert.deepEqual(await total('Ant'), before);
    const [c] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_scores where fixture_id = ${ids.chelsea}`;
    assert.equal(c.n, 2);
  });

  test('manual adjustments and opening balances survive recalculation', async () => {
    const ant = await memberId('Ant');
    assert.equal((await addAdjustment(jon, ant, 2, '', null)).ok, false, 'reason required');
    assert.ok((await addAdjustment(jon, ant, -2, 'Late prediction penalty', ids.chelsea)).ok);
    await finaliseFixture(ids.chelsea, jon, 'test');
    const t = await total('Ant');
    assert.equal(t.openingPoints, 17);
    assert.equal(t.matchPoints, 15);
    assert.equal(t.adjustmentPoints, -2);
    assert.equal(t.totalPoints, 30);
  });

  test('correcting the scorer recalculates (replaces, not adds)', async () => {
    const r = await saveManualResult(jon, ids.chelsea, manual(1, 0, 'Rice', 'Saka'));
    assert.ok(r.ok);
    // Ant picked Saka (scorer) / Rice (assister): both crossovers now -> 3+3+1+1 = 8
    assert.equal((await total('Ant')).matchPoints, 8);
    const [aud] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'result.corrected'`;
    assert.equal(aud.n, 1);
  });

  test('reopening withdraws the fixture points until it is finalised again', async () => {
    await reopenScoring(jon, ids.chelsea, 'Checking the replay');
    assert.equal((await total('Ant')).matchPoints, 0);
    await finaliseFixture(ids.chelsea, jon, 'test', { confirmReview: true });
    assert.equal((await total('Ant')).matchPoints, 8);
  });

  test('a manual result with an invalid outcome is rejected', async () => {
    const r = await saveManualResult(jon, ids.chelsea, manual(0, 0, 'Saka', 'none'));
    assert.equal(r.ok, false);
  });
});

describe('Automatic feed processing', () => {
  const goal = (key: string, minute: number, scorer: string, assist: string | null | 'unknown', side: 'arsenal' | 'opponent' = 'arsenal', type: 'goal' | 'own_goal' = 'goal') => ({
    key, minute, extraMinute: null, type, side,
    scorerProviderId: scorer, scorerName: scorer,
    assistStatus: (assist === 'unknown' ? 'unknown' : assist ? 'credited' : 'unassisted') as 'credited' | 'unassisted' | 'unknown',
    assistProviderId: assist && assist !== 'unknown' ? assist : null, assistName: assist && assist !== 'unknown' ? assist : null,
  });

  async function feedFixture(opponent: string) {
    const r = await createFixture(jon, fixtureInput(opponent, inHours(2), opponent));
    assert.ok(r.ok);
    if (!r.ok) throw new Error();
    await sql`update fixtures set provider = 'test', provider_fixture_id = ${opponent}, manual_override = false where id = ${r.id}`;
    const mark = await memberId('Mark D');
    await savePrediction(mark, r.id, { arsenalGoals: 2, opponentGoals: 1, scorer: players.Saka, assister: players.Odegaard });
    await kickoffNow(r.id, 'live');
    return r.id;
  }
  const status = async (id: string) => (await sql<{ scoringStatus: string }[]>`select scoring_status from fixtures where id = ${id}`)[0].scoringStatus;

  test('score without events is held for verification (no points awarded)', async () => {
    const id = await feedFixture('Spurs');
    const before = (await total('Mark D')).matchPoints;
    const feed: FeedMatch = { status: 'finished', arsenalGoals: 2, opponentGoals: 1, goals: null, substitutions: [] };
    await applyFeedMatch(id, 'test', feed);
    assert.equal(await status(id), 'awaiting_verification');
    assert.equal((await total('Mark D')).matchPoints, before);
    ids.spurs = id;
  });

  test('complete events finalise automatically; duplicate events are ignored', async () => {
    const id = ids.spurs;
    const before = (await total('Mark D')).matchPoints;
    const feed: FeedMatch = {
      status: 'finished', arsenalGoals: 2, opponentGoals: 1,
      goals: [goal('g1', 10, 'Saka', 'Odegaard'), goal('g1', 10, 'Saka', 'Odegaard'), goal('g2', 30, 'Son', null, 'opponent'), goal('g3', 80, 'Havertz', 'unknown')],
      substitutions: [{ key: 's1', minute: 60, side: 'arsenal', playerOnName: 'Rice', playerOffName: 'Saka' }],
    };
    const msg = await applyFeedMatch(id, 'test', feed);
    assert.match(msg, /finalised/);
    assert.equal(await status(id), 'finalised');
    assert.equal((await total('Mark D')).matchPoints, before + 15);
    // Second identical feed run: unchanged, no extra points.
    assert.equal(await applyFeedMatch(id, 'test', feed), 'unchanged');
    assert.equal((await total('Mark D')).matchPoints, before + 15);
  });

  test('a later, less complete feed never withdraws finalised points', async () => {
    const before = (await total('Mark D')).matchPoints;
    await applyFeedMatch(ids.spurs, 'test', { status: 'finished', arsenalGoals: 2, opponentGoals: 1, goals: [], substitutions: [] });
    assert.equal(await status(ids.spurs), 'finalised');
    assert.equal((await total('Mark D')).matchPoints, before);
  });

  test('a provider correction to the scorer is applied and recalculated', async () => {
    const before = (await total('Mark D')).matchPoints;
    const feed: FeedMatch = {
      status: 'finished', arsenalGoals: 2, opponentGoals: 1,
      goals: [goal('g1', 10, 'Havertz', 'Odegaard'), goal('g2', 30, 'Son', null, 'opponent'), goal('g3', 80, 'Saka', null)],
      substitutions: [],
    };
    await applyFeedMatch(ids.spurs, 'test', feed);
    // Mark: Saka (scorer pick) no longer first scorer, Odegaard still assister -> 0+5+1+1 = 7 (was 15)
    assert.equal((await total('Mark D')).matchPoints, before - 8);
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'result.feed_correction'`;
    assert.equal(a.n, 1);
  });

  test('missing assist data holds the match', async () => {
    const id = await feedFixture('Villa');
    await applyFeedMatch(id, 'test', { status: 'finished', arsenalGoals: 1, opponentGoals: 0, goals: [goal('v1', 5, 'Saka', 'unknown')], substitutions: [] });
    assert.equal(await status(id), 'awaiting_verification');
    // Admin decision: finalise with player categories void -> only result/total count.
    const before = (await total('Mark D')).matchPoints;
    const r = await finaliseWithPlayerCategoriesVoid(jon, id, 'No reliable assist data from any source');
    assert.equal(r.status, 'finalised');
    // Mark predicted 2-1 v 1-0: result 1, total 0 -> 1
    assert.equal((await total('Mark D')).matchPoints, before + 1);
  });

  test('own goal first: held for review, then admin verification finalises', async () => {
    const id = await feedFixture('Wolves');
    await applyFeedMatch(id, 'test', {
      status: 'finished', arsenalGoals: 2, opponentGoals: 0,
      goals: [goal('w1', 3, 'WolvesDefender', null, 'arsenal', 'own_goal'), goal('w2', 50, 'Saka', 'Odegaard')],
      substitutions: [],
    });
    assert.equal(await status(id), 'review_required');
    const before = (await total('Mark D')).matchPoints;
    const r = await verifyResult(jon, id);
    assert.equal(r.status, 'finalised');
    // Mark: Saka/Odegaard correct, 2-1 v 2-0: result 1, total 0 -> 11
    assert.equal((await total('Mark D')).matchPoints, before + 11);
  });

  test('admin-verified manual result is never overwritten by a conflicting feed', async () => {
    const id = await feedFixture('Fulham');
    await saveManualResult(jon, id, manual(2, 1, 'Saka', 'Odegaard'));
    const before = (await total('Mark D')).matchPoints;
    const msg = await applyFeedMatch(id, 'test', {
      status: 'finished', arsenalGoals: 3, opponentGoals: 1,
      goals: [goal('f1', 5, 'Havertz', null), goal('f2', 20, 'Saka', null), goal('f3', 30, 'Rice', null), goal('f4', 40, 'X', null, 'opponent')],
      substitutions: [],
    });
    assert.equal(msg, 'discrepancy flagged');
    assert.equal((await total('Mark D')).matchPoints, before);
    const [r] = await sql<{ arsenalGoals: number; source: string }[]>`select arsenal_goals, source from match_results where fixture_id = ${id}`;
    assert.deepEqual(r, { arsenalGoals: 2, source: 'manual' });
    const [d] = await sql<{ discrepancy: string }[]>`select discrepancy from feed_results where fixture_id = ${id}`;
    assert.match(d.discrepancy, /differs/);
  });

  test('abandoned matches are void and award nothing', async () => {
    const id = await feedFixture('Brighton');
    const before = (await total('Mark D')).matchPoints;
    await applyFeedMatch(id, 'test', { status: 'abandoned', arsenalGoals: 1, opponentGoals: 0, goals: [], substitutions: [] });
    assert.equal(await status(id), 'void');
    assert.equal((await total('Mark D')).matchPoints, before);
    const r = await finaliseFixture(id, jon, 'test');
    assert.equal(r.status, 'blocked');
  });
});

describe('Members', () => {
  test('a new member gets a PIN, an opening balance and appears on the leaderboard', async () => {
    const r = await addMember(jon, 'New Guy', 0);
    assert.ok(r.ok);
    if (r.ok) assert.match(r.issued.pin, /^\d{4}$/);
    const dup = await addMember(jon, 'new guy', 0);
    assert.equal(dup.ok, false);
    const board = await getLeaderboard();
    assert.ok(board.some((b) => b.displayName === 'New Guy'));
  });

  test('the last active admin cannot be deactivated', async () => {
    const knighty = await memberId('Knighty');
    await setMemberActive(jon, knighty, false);
    await assert.rejects(setMemberActive({ id: knighty, displayName: 'Knighty' }, jon.id, false));
    await setMemberActive(jon, knighty, true);
  });
});
