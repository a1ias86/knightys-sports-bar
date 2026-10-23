/**
 * API-Football (api-sports.io) v3 adapter.
 *
 * Written against the published v3 documentation. NOT yet tested against the live API (no key was
 * available during the build). Parsing is covered by unit tests using documented response shapes.
 * Plan notes: free plan = 100 requests/day with limited seasons; the current season normally needs a
 * paid plan (Pro, about $19/month). One /fixtures?id= call returns score, events and lineups together.
 */
import type { FixtureStatus } from '../fixtures';
import type { FeedGoal, FeedMatch, FeedSubstitution } from '../results';
import { seasonFor } from '../fixtures';
import { fetchJson, ProviderError, type FootballProvider, type ProviderFixture, type ProviderLineup } from './types';

const BASE = 'https://v3.football.api-sports.io';

/** API-Football league id → our competition code. */
const LEAGUES: Record<number, string> = { 39: 'PL', 45: 'FAC', 48: 'EFL', 2: 'UCL' };

export function mapApiFootballStatus(short: string): FixtureStatus {
  switch (short) {
    case 'TBD': case 'NS': return 'scheduled';
    case '1H': case 'HT': case '2H': case 'ET': case 'BT': case 'P': case 'LIVE': case 'SUSP': case 'INT': return 'live';
    case 'FT': case 'AET': case 'PEN': case 'AWD': case 'WO': return 'finished';
    case 'PST': return 'postponed';
    case 'CANC': return 'cancelled';
    case 'ABD': return 'abandoned';
    default: return 'scheduled';
  }
}

interface AFFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { id: number; season: number; round: string };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
  events?: AFEvent[];
  lineups?: AFLineup[];
}
interface AFEvent {
  time: { elapsed: number | null; extra: number | null };
  team: { id: number; name: string };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string;
}
interface AFLineup {
  team: { id: number };
  startXI: { player: { id: number; name: string; number: number | null; pos: string | null } }[];
  substitutes: { player: { id: number; name: string; number: number | null; pos: string | null } }[];
}

export function parseApiFootballFixture(f: AFFixture, arsenalId: number): ProviderFixture | null {
  const code = LEAGUES[f.league.id];
  if (!code) return null;
  const home = f.teams.home.id === arsenalId;
  const opp = home ? f.teams.away : f.teams.home;
  const kickoffAt = new Date(f.fixture.date);
  return {
    providerFixtureId: String(f.fixture.id),
    competitionCode: code,
    season: seasonFor(kickoffAt),
    round: code === 'PL' ? '' : f.league.round.slice(0, 40),
    opponent: opp.name,
    opponentProviderId: String(opp.id),
    venue: home ? 'H' : 'A',
    kickoffAt,
    status: mapApiFootballStatus(f.fixture.status.short),
  };
}

/**
 * Convert a fixture with embedded events into our FeedMatch.
 * - Goal events: type "Goal", detail "Normal Goal" | "Own Goal" | "Penalty". "Missed Penalty" is ignored.
 * - The event's team is treated as the team credited with the goal. If that assumption is wrong for own
 *   goals, the goal counts will not match the score and the match is held for admin verification.
 * - API-Football uses a null assist both for "no assist" and "not recorded", so a null assist is treated as
 *   UNKNOWN (never guessed), except for penalties, which are always unassisted.
 */
export function parseApiFootballMatch(f: AFFixture, arsenalId: number): FeedMatch {
  const home = f.teams.home.id === arsenalId;
  const status = mapApiFootballStatus(f.fixture.status.short);
  const ag = home ? f.goals.home : f.goals.away;
  const og = home ? f.goals.away : f.goals.home;
  const events = f.events;
  let goals: FeedGoal[] | null = null;
  const substitutions: FeedSubstitution[] = [];
  if (Array.isArray(events)) {
    goals = [];
    events.forEach((e, i) => {
      const side = e.team.id === arsenalId ? 'arsenal' : 'opponent';
      if (e.type === 'Goal' && e.detail !== 'Missed Penalty') {
        const own = /own goal/i.test(e.detail);
        const pen = /penalty/i.test(e.detail);
        const hasAssist = e.assist?.id != null || (e.assist?.name ?? '') !== '';
        goals!.push({
          key: `af:${f.fixture.id}:${e.time.elapsed}:${e.time.extra ?? 0}:${e.player.id ?? e.player.name}:${own ? 'og' : 'g'}`,
          minute: e.time.elapsed,
          extraMinute: e.time.extra,
          type: own ? 'own_goal' : 'goal',
          side,
          scorerProviderId: e.player.id != null ? String(e.player.id) : null,
          scorerName: e.player.name,
          assistStatus: own ? 'unassisted' : hasAssist ? 'credited' : pen ? 'unassisted' : 'unknown',
          assistProviderId: e.assist?.id != null ? String(e.assist.id) : null,
          assistName: e.assist?.name ?? null,
        });
      } else if (e.type === 'subst') {
        substitutions.push({
          key: `af:${f.fixture.id}:sub:${i}`,
          minute: e.time.elapsed,
          side,
          // API-Football: player = player going OFF, assist = player coming ON
          playerOffName: e.player.name,
          playerOnName: e.assist?.name ?? null,
        });
      }
    });
  }
  return { status, arsenalGoals: ag, opponentGoals: og, goals: status === 'finished' || status === 'live' ? goals : null, substitutions };
}

export function parseApiFootballLineups(lineups: AFLineup[], arsenalId: number): ProviderLineup[] {
  const out: ProviderLineup[] = [];
  for (const l of lineups) {
    const side = l.team.id === arsenalId ? 'arsenal' : 'opponent';
    for (const [list, role] of [[l.startXI, 'starter'], [l.substitutes, 'substitute']] as const) {
      for (const { player } of list) {
        out.push({ side, role, player: { providerPlayerId: String(player.id), name: player.name, position: player.pos, shirtNumber: player.number } });
      }
    }
  }
  return out;
}

export function createApiFootball(key: string, arsenalTeamId: string, season: number): FootballProvider {
  if (!key) throw new ProviderError('API_FOOTBALL_KEY is not set');
  const arsenalId = Number(arsenalTeamId || 42);
  const headers = { 'x-apisports-key': key };
  async function get<T>(path: string): Promise<T[]> {
    const body = (await fetchJson(`${BASE}${path}`, headers)) as { response?: T[]; errors?: unknown };
    const errs = body.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs as object).length)) {
      throw new ProviderError(`API-Football error: ${JSON.stringify(errs).slice(0, 200)}`);
    }
    return body.response ?? [];
  }
  return {
    name: 'api-football',
    arsenalProviderId: String(arsenalId),
    capabilities: { fixtures: true, results: true, goalEvents: true, assists: true, lineups: true, substitutions: true, squads: true },
    async fetchFixtures() {
      const rows = await get<AFFixture>(`/fixtures?team=${arsenalId}&season=${season}`);
      return rows.map((r) => parseApiFootballFixture(r, arsenalId)).filter((x): x is ProviderFixture => x !== null);
    },
    async fetchMatch(id) {
      const [row] = await get<AFFixture>(`/fixtures?id=${encodeURIComponent(id)}`);
      if (!row) throw new ProviderError(`Fixture ${id} not found at API-Football`);
      return parseApiFootballMatch(row, arsenalId);
    },
    async fetchLineups(id) {
      const [row] = await get<AFFixture>(`/fixtures?id=${encodeURIComponent(id)}`);
      if (!row?.lineups?.length) return null;
      return parseApiFootballLineups(row.lineups, arsenalId);
    },
    async fetchSquad(teamId) {
      const [row] = await get<{ players: { id: number; name: string; number: number | null; position: string | null }[] }>(`/players/squads?team=${encodeURIComponent(teamId)}`);
      if (!row) return null;
      return row.players.map((p) => ({ providerPlayerId: String(p.id), name: p.name, position: p.position, shirtNumber: p.number }));
    },
  };
}
