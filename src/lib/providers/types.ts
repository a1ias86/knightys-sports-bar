import type { FixtureStatus } from '../fixtures';
import type { FeedMatch } from '../results';

/**
 * Football data provider adapter. Swap providers by implementing this interface and
 * registering it in ./index.ts. Nothing else in the app knows which provider is in use.
 */
export interface ProviderFixture {
  providerFixtureId: string;
  /** Our competition code: PL, FAC, EFL, UCL. Unknown competitions are ignored. */
  competitionCode: string;
  season: string;
  round: string;
  opponent: string;
  opponentProviderId: string | null;
  venue: 'H' | 'A' | 'N';
  kickoffAt: Date;
  status: FixtureStatus;
}

export interface ProviderPlayer {
  providerPlayerId: string;
  name: string;
  position: string | null;
  shirtNumber: number | null;
}

export interface ProviderLineup {
  side: 'arsenal' | 'opponent';
  role: 'starter' | 'substitute';
  player: ProviderPlayer;
}

export interface FootballProvider {
  readonly name: string;
  /** What this provider/plan is believed to support. Shown on the admin status page. */
  readonly capabilities: { fixtures: boolean; results: boolean; goalEvents: boolean; assists: boolean; lineups: boolean; substitutions: boolean; squads: boolean };
  fetchFixtures(): Promise<ProviderFixture[]>;
  fetchMatch(providerFixtureId: string): Promise<FeedMatch>;
  fetchLineups(providerFixtureId: string): Promise<ProviderLineup[] | null>;
  fetchSquad(teamProviderId: string): Promise<ProviderPlayer[] | null>;
  readonly arsenalProviderId: string;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** "Chelsea FC" / "AFC Bournemouth" → "chelsea" / "bournemouth" for matching names across sources. */
export function normaliseTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(fc|afc|cf|football club)\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 15000): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (!res.ok) throw new ProviderError(`${new URL(url).host} responded ${res.status}`, res.status);
  return res.json();
}
