import { env } from '../env';
import { createApiFootball } from './api-football';
import { createFootballData } from './football-data';
import type { FootballProvider } from './types';

export type ProviderState =
  | { configured: false; name: 'none'; reason: string }
  | { configured: true; name: string; provider: FootballProvider }
  | { configured: false; name: string; reason: string };

let testOverride: FootballProvider | null = null;
/** Tests only: substitute a fake provider. */
export function setTestProvider(p: FootballProvider | null) {
  if (process.env.APP_ENV !== 'test') throw new Error('setTestProvider is for tests only');
  testOverride = p;
}

/** Returns the configured provider, or a reason why automatic data is off. Never throws. */
export function getProvider(): ProviderState {
  if (testOverride) return { configured: true, name: testOverride.name, provider: testOverride };
  const which = env.footballProvider;
  if (which === 'none') return { configured: false, name: 'none', reason: 'No football data provider configured (FOOTBALL_PROVIDER=none). Fixtures and results are managed manually.' };
  try {
    if (which === 'api-football') return { configured: true, name: which, provider: createApiFootball(env.apiFootballKey, env.arsenalTeamId, env.footballSeason) };
    return { configured: true, name: which, provider: createFootballData(env.footballDataToken, env.arsenalTeamId, env.footballSeason) };
  } catch (e) {
    return { configured: false, name: which, reason: (e as Error).message };
  }
}
