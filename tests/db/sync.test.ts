import { resetDatabase } from './helpers';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../../src/lib/db';
import { setTestProvider } from '../../src/lib/providers';
import { syncFixtures, syncResults, syncSquads } from '../../src/lib/sync';
import { createFixture } from '../../src/lib/fixtures';
import type { FootballProvider, ProviderFixture } from '../../src/lib/providers/types';
import type { FeedMatch } from '../../src/lib/results';

let fixtures: ProviderFixture[] = [];
const matches: Record<string, FeedMatch> = {};
let failNext = false;
let calls = 0;

const fake: FootballProvider = {
  name: 'fake',
  arsenalProviderId: '42',
  capabilities: { fixtures: true, results: true, goalEvents: true, assists: true, lineups: true, substitutions: true, squads: true },
  async fetchFixtures() {
    calls++;
    if (failNext) { failNext = false; throw new Error('Provider timeout'); }
    return fixtures;
  },
  async fetchMatch(id) { calls++; return matches[id]; },
  async fetchLineups() { return null; },
  async fetchSquad(team) {
    return team === '42' ? [{ providerPlayerId: 's1', name: 'Saka', position: 'Attacker', shirtNumber: 7 }, { providerPlayerId: 's2', name: 'Odegaard', position: 'Midfield', shirtNumber: 8 }] : [];
  },
};

const days = (d: number) => new Date(Date.now() + d * 86400_000);
const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures`)[0].n;

before(async () => {
  await resetDatabase();
  setTestProvider(fake);
});
after(async () => { setTestProvider(null); await closeDb(); });

describe('Fixture synchronisation', () => {
  test('creates fixtures and is idempotent', async () => {
    fixtures = [
      { providerFixtureId: '100', competitionCode: 'PL', season: '2026-27', round: '', opponent: 'Chelsea', opponentProviderId: '49', venue: 'H', kickoffAt: days(3), status: 'scheduled' },
      { providerFixtureId: '101', competitionCode: 'PL', season: '2026-27', round: '', opponent: 'Fulham', opponentProviderId: '36', venue: 'A', kickoffAt: days(10), status: 'scheduled' },
      { providerFixtureId: '102', competitionCode: 'XYZ', season: '2026-27', round: '', opponent: 'Somebody', opponentProviderId: '1', venue: 'A', kickoffAt: days(12), status: 'scheduled' },
    ];
    const r = await syncFixtures();
    assert.equal(r.status, 'success');
    assert.equal(await count(), 2);
    await syncFixtures();
    assert.equal(await count(), 2, 'second run creates no duplicates');
  });

  test('links a manually added fixture instead of duplicating it', async () => {
    const [jon] = await sql<{ id: string }[]>`select id from members where display_name = 'Jon'`;
    const m = await createFixture({ id: jon.id, displayName: 'Jon' }, { competitionCode: 'PL', season: '2026-27', round: '', opponent: 'Liverpool', venue: 'H', kickoffAt: days(20), status: 'scheduled' });
    assert.ok(m.ok);
    await sql`update fixtures set manual_override = false where opponent = 'Liverpool'`;
    fixtures.push({ providerFixtureId: '103', competitionCode: 'PL', season: '2026-27', round: '', opponent: 'Liverpool FC', opponentProviderId: '40', venue: 'H', kickoffAt: days(21), status: 'scheduled' });
    await syncFixtures();
    assert.equal(await count(), 3);
    const [f] = await sql<{ providerFixtureId: string; kickoffAt: Date }[]>`select provider_fixture_id, kickoff_at from fixtures where opponent = 'Liverpool'`;
    assert.equal(f.providerFixtureId, '103');
    assert.equal(f.kickoffAt.getTime(), fixtures[3].kickoffAt.getTime(), 'rescheduled from the feed');
  });

  test('postponement and rescheduling from the feed', async () => {
    fixtures[0] = { ...fixtures[0], status: 'postponed' };
    await syncFixtures();
    assert.equal((await sql<{ status: string }[]>`select status from fixtures where provider_fixture_id = '100'`)[0].status, 'postponed');
    fixtures[0] = { ...fixtures[0], status: 'scheduled', kickoffAt: days(30) };
    await syncFixtures();
    const [f] = await sql<{ status: string; kickoffAt: Date }[]>`select status, kickoff_at from fixtures where provider_fixture_id = '100'`;
    assert.equal(f.status, 'scheduled');
    assert.equal(f.kickoffAt.getTime(), fixtures[0].kickoffAt.getTime());
  });

  test('admin-locked fixtures are not changed by the feed', async () => {
    await sql`update fixtures set manual_override = true where provider_fixture_id = '101'`;
    const before = (await sql<{ kickoffAt: Date }[]>`select kickoff_at from fixtures where provider_fixture_id = '101'`)[0].kickoffAt;
    fixtures[1] = { ...fixtures[1], kickoffAt: days(11) };
    await syncFixtures();
    const after = (await sql<{ kickoffAt: Date }[]>`select kickoff_at from fixtures where provider_fixture_id = '101'`)[0].kickoffAt;
    assert.equal(after.getTime(), before.getTime());
  });

  test('a failed sync is recorded and existing fixtures are preserved', async () => {
    failNext = true;
    const r = await syncFixtures();
    assert.equal(r.status, 'error');
    assert.equal(await count(), 3);
    const [run] = await sql<{ status: string; message: string }[]>`select status, message from sync_runs where job = 'fixtures' order by started_at desc limit 1`;
    assert.deepEqual(run, { status: 'error', message: 'Provider timeout' });
  });

  test('overlapping runs are prevented', async () => {
    await sql`insert into job_locks (job, locked_until, holder) values ('fixtures', now() + interval '5 minutes', 'other')`;
    const r = await syncFixtures();
    assert.equal(r.status, 'skipped');
    await sql`delete from job_locks`;
  });
});

describe('Results synchronisation', () => {
  test('only fixtures past full time are fetched, and finished ones are scored', async () => {
    await syncSquads();
    await sql`update fixtures set kickoff_at = now() - interval '3 hours', manual_override = false where provider_fixture_id = '101'`;
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where provider_fixture_id = '101'`;
    const [bob] = await sql<{ id: string }[]>`select id from members where display_name = 'Bob'`;
    await sql`insert into predictions (fixture_id, member_id, arsenal_goals, opponent_goals, scorer_name, assister_name) values (${fx.id}, ${bob.id}, 1, 0, 'Saka', 'Odegaard')`;
    matches['101'] = {
      status: 'finished', arsenalGoals: 1, opponentGoals: 0, substitutions: [],
      goals: [{ key: 'k1', minute: 9, extraMinute: null, type: 'goal', side: 'arsenal', scorerProviderId: 's1', scorerName: 'Saka', assistStatus: 'credited', assistProviderId: 's2', assistName: 'Odegaard' }],
    };
    calls = 0;
    const r = await syncResults();
    assert.equal(r.status, 'success');
    assert.equal(calls, 1, 'only the one due fixture was requested');
    const [t] = await sql<{ matchPoints: number }[]>`select match_points from member_totals where display_name = 'Bob'`;
    assert.equal(t.matchPoints, 20, 'exact 1-0 + Saka + Odegaard + total + result + bonus');
    calls = 0;
    await syncResults();
    assert.equal(calls, 0, 'a finalised fixture is not fetched again');
  });

  test('the fixture sync never reschedules or cancels a match that has been scored', async () => {
    const [before] = await sql<{ kickoffAt: Date; status: string; scoringStatus: string }[]>`
      select kickoff_at, status, scoring_status from fixtures where provider_fixture_id = '101'`;
    await sql`update fixtures set manual_override = false where provider_fixture_id = '101'`;
    const i = fixtures.findIndex((f) => f.providerFixtureId === '101');
    fixtures[i] = { ...fixtures[i], status: 'cancelled', kickoffAt: days(40) };
    await syncFixtures();
    const [after] = await sql<{ kickoffAt: Date; status: string; scoringStatus: string }[]>`
      select kickoff_at, status, scoring_status from fixtures where provider_fixture_id = '101'`;
    assert.deepEqual(after, before);
    const [t] = await sql<{ matchPoints: number }[]>`select match_points from member_totals where display_name = 'Bob'`;
    assert.equal(t.matchPoints, 20);
  });
});
