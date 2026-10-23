/**
 * Parsing tests built from the providers' DOCUMENTED response shapes. They prove our mapping logic,
 * not that the live APIs behave this way; see docs/INTEGRATIONS.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiFootballFixture, parseApiFootballMatch, parseApiFootballLineups, mapApiFootballStatus } from '../../src/lib/providers/api-football';
import { parseFootballDataFixture, parseFootballDataMatch, mapFootballDataStatus } from '../../src/lib/providers/football-data';
import { normaliseTeam } from '../../src/lib/providers/types';
import { deriveOutcome } from '../../src/lib/scoring';

const AF_ARS = 42;
const afFixture = {
  fixture: { id: 1208001, date: '2026-10-25T16:30:00+00:00', status: { short: 'FT' } },
  league: { id: 39, season: 2026, round: 'Regular Season - 9' },
  teams: { home: { id: 42, name: 'Arsenal' }, away: { id: 49, name: 'Chelsea' } },
  goals: { home: 2, away: 1 },
  events: [
    { time: { elapsed: 12, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 1460, name: 'B. Saka' }, assist: { id: 37127, name: 'M. Ødegaard' }, type: 'Goal', detail: 'Normal Goal' },
    { time: { elapsed: 30, extra: null }, team: { id: 49, name: 'Chelsea' }, player: { id: 5, name: 'C. Palmer' }, assist: { id: null, name: null }, type: 'Goal', detail: 'Penalty' },
    { time: { elapsed: 55, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 1460, name: 'B. Saka' }, assist: { id: 2000, name: 'D. Rice' }, type: 'subst', detail: 'Substitution 1' },
    { time: { elapsed: 70, extra: null }, team: { id: 42, name: 'Arsenal' }, player: { id: 9, name: 'K. Havertz' }, assist: { id: null, name: null }, type: 'Goal', detail: 'Missed Penalty' },
    { time: { elapsed: 90, extra: 3 }, team: { id: 42, name: 'Arsenal' }, player: { id: 77, name: 'Defender X' }, assist: { id: null, name: null }, type: 'Goal', detail: 'Own Goal' },
  ],
};

describe('API-Football mapping', () => {
  test('fixture: opponent, venue, competition, season, UTC kickoff', () => {
    const f = parseApiFootballFixture(afFixture, AF_ARS)!;
    assert.equal(f.opponent, 'Chelsea');
    assert.equal(f.venue, 'H');
    assert.equal(f.competitionCode, 'PL');
    assert.equal(f.season, '2026-27');
    assert.equal(f.round, '');
    assert.equal(f.kickoffAt.toISOString(), '2026-10-25T16:30:00.000Z');
    assert.equal(f.status, 'finished');
  });
  test('unknown competitions are ignored', () => {
    assert.equal(parseApiFootballFixture({ ...afFixture, league: { id: 999, season: 2026, round: 'x' } }, AF_ARS), null);
  });
  test('statuses', () => {
    assert.equal(mapApiFootballStatus('NS'), 'scheduled');
    assert.equal(mapApiFootballStatus('HT'), 'live');
    assert.equal(mapApiFootballStatus('PST'), 'postponed');
    assert.equal(mapApiFootballStatus('ABD'), 'abandoned');
    assert.equal(mapApiFootballStatus('CANC'), 'cancelled');
  });
  test('match: goals, penalty unassisted, missed penalty ignored, substitutions', () => {
    const m = parseApiFootballMatch(afFixture, AF_ARS);
    assert.equal(m.arsenalGoals, 2);
    assert.equal(m.opponentGoals, 1);
    assert.equal(m.goals!.length, 3);
    assert.equal(m.goals![0].assistStatus, 'credited');
    assert.equal(m.goals![1].assistStatus, 'unassisted', 'penalties are unassisted');
    assert.equal(m.goals![2].type, 'own_goal');
    assert.equal(m.substitutions.length, 1);
    assert.equal(m.substitutions[0].playerOnName, 'D. Rice');
  });
  test('a null assist on an open-play goal is UNKNOWN, never assumed', () => {
    const fx = { ...afFixture, goals: { home: 1, away: 0 }, events: [{ ...afFixture.events[0], assist: { id: null, name: null } }] };
    assert.equal(parseApiFootballMatch(fx, AF_ARS).goals![0].assistStatus, 'unknown');
  });
  test('away fixture flips the score', () => {
    const fx = { ...afFixture, teams: { home: afFixture.teams.away, away: afFixture.teams.home }, goals: { home: 3, away: 0 } };
    const m = parseApiFootballMatch(fx, AF_ARS);
    assert.equal(m.arsenalGoals, 0);
    assert.equal(m.opponentGoals, 3);
    assert.equal(parseApiFootballFixture(fx, AF_ARS)!.venue, 'A');
  });
  test('line-ups', () => {
    const l = parseApiFootballLineups([{ team: { id: 42 }, startXI: [{ player: { id: 1, name: 'Raya', number: 22, pos: 'G' } }], substitutes: [{ player: { id: 2, name: 'Arrizabalaga', number: 13, pos: 'G' } }] }], AF_ARS);
    assert.deepEqual(l.map((x) => [x.side, x.role]), [['arsenal', 'starter'], ['arsenal', 'substitute']]);
  });
});

describe('football-data.org mapping', () => {
  const FD_ARS = 57;
  const m = {
    id: 540001, utcDate: '2026-11-01T15:00:00Z', status: 'FINISHED', matchday: 10, stage: 'REGULAR_SEASON',
    competition: { code: 'PL' },
    homeTeam: { id: 63, name: 'Fulham FC', shortName: 'Fulham' }, awayTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal' },
    score: { fullTime: { home: 0, away: 2 } },
  };
  test('fixture', () => {
    const f = parseFootballDataFixture(m, FD_ARS)!;
    assert.equal(f.opponent, 'Fulham');
    assert.equal(f.venue, 'A');
    assert.equal(f.kickoffAt.toISOString(), '2026-11-01T15:00:00.000Z');
  });
  test('free plan (no goals array): goals = null, score only', () => {
    const r = parseFootballDataMatch(m, FD_ARS);
    assert.equal(r.goals, null);
    assert.equal(r.arsenalGoals, 2);
    assert.equal(r.opponentGoals, 0);
  });
  test('deep data goals', () => {
    const r = parseFootballDataMatch({ ...m, goals: [
      { minute: 20, injuryTime: null, type: 'REGULAR', team: { id: 57 }, scorer: { id: 1, name: 'Saka' }, assist: { id: 2, name: 'Odegaard' } },
      { minute: 80, injuryTime: null, type: 'PENALTY', team: { id: 57 }, scorer: { id: 3, name: 'Havertz' }, assist: null },
    ] }, FD_ARS);
    assert.equal(r.goals!.length, 2);
    assert.equal(r.goals![0].assistStatus, 'credited');
    assert.equal(r.goals![1].assistStatus, 'unassisted');
  });
  test('statuses', () => {
    assert.equal(mapFootballDataStatus('TIMED'), 'scheduled');
    assert.equal(mapFootballDataStatus('PAUSED'), 'live');
    assert.equal(mapFootballDataStatus('POSTPONED'), 'postponed');
  });
});

describe('Team name matching', () => {
  test('provider names match manual names', () => {
    assert.equal(normaliseTeam('Chelsea FC'), normaliseTeam('Chelsea'));
    assert.equal(normaliseTeam('AFC Bournemouth'), normaliseTeam('Bournemouth'));
    assert.equal(normaliseTeam('Brighton & Hove Albion'), normaliseTeam('Brighton and Hove Albion'));
  });
});

describe('End to end: provider payload → scoring outcome', () => {
  test('API-Football payload derives the first scorer and assister', () => {
    const m = parseApiFootballMatch(afFixture, AF_ARS);
    // Map provider ids straight through for this test.
    const d = deriveOutcome(m.arsenalGoals!, m.opponentGoals!, m.goals!.map((g, i) => ({
      seq: i + 1, type: g.type, side: g.side, scorerId: g.scorerProviderId,
      assist: g.assistStatus === 'credited' ? { status: 'credited' as const, playerId: g.assistProviderId! } : { status: g.assistStatus as 'unassisted' | 'unknown' },
    })));
    assert.deepEqual(d.outcome.firstScorer, { kind: 'player', id: '1460' });
    assert.deepEqual(d.outcome.firstAssister, { kind: 'player', id: '37127' });
  });
});
