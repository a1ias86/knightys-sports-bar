/**
 * football-data.org v4 adapter.
 *
 * Written against the published v4 documentation. NOT yet tested against the live API (no token was
 * available during the build). Free plan: Premier League fixtures and (delayed) scores, 10 requests/min,
 * no goal scorers, assists or lineups. Those need a paid "Deep Data" plan; without it every finished
 * match waits for the admin to enter the first goalscorer/assister, which the app handles normally.
 */
import type { FixtureStatus } from '../fixtures';
import type { FeedGoal, FeedMatch, FeedSubstitution } from '../results';
import { seasonFor } from '../fixtures';
import { fetchJson, ProviderError, type FootballProvider, type ProviderFixture, type ProviderLineup, type ProviderPlayer } from './types';

const BASE = 'https://api.football-data.org/v4';
const COMPETITIONS: Record<string, string> = { PL: 'PL', FAC: 'FAC', CL: 'UCL' };

export function mapFootballDataStatus(s: string): FixtureStatus {
  switch (s) {
    case 'SCHEDULED': case 'TIMED': return 'scheduled';
    case 'IN_PLAY': case 'PAUSED': case 'LIVE': case 'SUSPENDED': return 'live';
    case 'FINISHED': case 'AWARDED': return 'finished';
    case 'POSTPONED': return 'postponed';
    case 'CANCELLED': return 'cancelled';
    default: return 'scheduled';
  }
}

interface FDTeam { id: number; name: string; shortName?: string; lineup?: FDPlayer[]; bench?: FDPlayer[] }
interface FDPlayer { id: number; name: string; position?: string | null; shirtNumber?: number | null }
interface FDMatch {
  id: number;
  utcDate: string;
  status: string;
  stage?: string;
  matchday?: number | null;
  competition: { code: string };
  homeTeam: FDTeam;
  awayTeam: FDTeam;
  score: { fullTime: { home: number | null; away: number | null } };
  goals?: { minute: number | null; injuryTime: number | null; type: string; team: { id: number }; scorer: { id: number | null; name: string | null } | null; assist: { id: number | null; name: string | null } | null }[];
  substitutions?: { minute: number | null; team: { id: number }; playerOut: { name: string } | null; playerIn: { name: string } | null }[];
}

const teamName = (t: FDTeam) => (t.shortName || t.name).replace(/\s+FC$/, '');

export function parseFootballDataFixture(m: FDMatch, arsenalId: number): ProviderFixture | null {
  const code = COMPETITIONS[m.competition.code];
  if (!code) return null;
  const home = m.homeTeam.id === arsenalId;
  const opp = home ? m.awayTeam : m.homeTeam;
  const kickoffAt = new Date(m.utcDate);
  return {
    providerFixtureId: String(m.id),
    competitionCode: code,
    season: seasonFor(kickoffAt),
    round: code === 'PL' ? '' : (m.stage ?? '').slice(0, 40),
    opponent: teamName(opp),
    opponentProviderId: String(opp.id),
    venue: home ? 'H' : 'A',
    kickoffAt,
    status: mapFootballDataStatus(m.status),
  };
}

/** goals[] is only present with a Deep Data plan; when absent we report "no events" (goals: null). */
export function parseFootballDataMatch(m: FDMatch, arsenalId: number): FeedMatch {
  const home = m.homeTeam.id === arsenalId;
  const status = mapFootballDataStatus(m.status);
  let goals: FeedGoal[] | null = null;
  if (Array.isArray(m.goals)) {
    goals = m.goals.map((g, i) => {
      const own = g.type === 'OWN';
      const pen = g.type === 'PENALTY';
      return {
        key: `fd:${m.id}:${i}:${g.minute}:${g.scorer?.id ?? g.scorer?.name}`,
        minute: g.minute,
        extraMinute: g.injuryTime,
        type: own ? 'own_goal' : 'goal',
        side: g.team.id === arsenalId ? 'arsenal' : 'opponent',
        scorerProviderId: g.scorer?.id != null ? String(g.scorer.id) : null,
        scorerName: g.scorer?.name ?? null,
        // A null assist could mean 'none' or 'not recorded', so it is treated as unknown (admin confirms).
        assistStatus: own || pen ? 'unassisted' : g.assist?.id != null || g.assist?.name ? 'credited' : 'unknown',
        assistProviderId: g.assist?.id != null ? String(g.assist.id) : null,
        assistName: g.assist?.name ?? null,
      };
    });
  }
  const substitutions: FeedSubstitution[] = (m.substitutions ?? []).map((s, i) => ({
    key: `fd:${m.id}:sub:${i}`, minute: s.minute, side: s.team.id === arsenalId ? 'arsenal' : 'opponent',
    playerOnName: s.playerIn?.name ?? null, playerOffName: s.playerOut?.name ?? null,
  }));
  return {
    status,
    arsenalGoals: home ? m.score.fullTime.home : m.score.fullTime.away,
    opponentGoals: home ? m.score.fullTime.away : m.score.fullTime.home,
    goals,
    substitutions,
  };
}

export function createFootballData(token: string, arsenalTeamId: string, season: number): FootballProvider {
  if (!token) throw new ProviderError('FOOTBALL_DATA_TOKEN is not set');
  const arsenalId = Number(arsenalTeamId || 57);
  const headers = { 'X-Auth-Token': token };
  return {
    name: 'football-data',
    arsenalProviderId: String(arsenalId),
    // Free-plan reality: fixtures and scores only. Deep Data adds the rest (detected per match).
    capabilities: { fixtures: true, results: true, goalEvents: false, assists: false, lineups: false, substitutions: false, squads: true },
    async fetchFixtures() {
      const body = (await fetchJson(`${BASE}/teams/${arsenalId}/matches?season=${season}`, headers)) as { matches?: FDMatch[] };
      return (body.matches ?? []).map((m) => parseFootballDataFixture(m, arsenalId)).filter((x): x is ProviderFixture => x !== null);
    },
    async fetchMatch(id) {
      const m = (await fetchJson(`${BASE}/matches/${encodeURIComponent(id)}`, headers)) as FDMatch;
      return parseFootballDataMatch(m, arsenalId);
    },
    async fetchLineups(id) {
      const m = (await fetchJson(`${BASE}/matches/${encodeURIComponent(id)}`, headers)) as FDMatch;
      const out: ProviderLineup[] = [];
      for (const t of [m.homeTeam, m.awayTeam]) {
        const side = t.id === arsenalId ? 'arsenal' : 'opponent';
        for (const [list, role] of [[t.lineup ?? [], 'starter'], [t.bench ?? [], 'substitute']] as const) {
          for (const p of list) out.push({ side, role, player: { providerPlayerId: String(p.id), name: p.name, position: p.position ?? null, shirtNumber: p.shirtNumber ?? null } });
        }
      }
      return out.length ? out : null;
    },
    async fetchSquad(teamId) {
      const t = (await fetchJson(`${BASE}/teams/${encodeURIComponent(teamId)}`, headers)) as { squad?: FDPlayer[] };
      if (!t.squad?.length) return null;
      return t.squad.map((p): ProviderPlayer => ({ providerPlayerId: String(p.id), name: p.name, position: p.position ?? null, shirtNumber: p.shirtNumber ?? null }));
    },
  };
}
