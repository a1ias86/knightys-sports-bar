/** Server-only environment access. Never import this from a client component. */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

export const env = {
  get appEnv(): 'production' | 'preview' | 'development' | 'test' {
    const v = process.env.APP_ENV ?? process.env.VERCEL_ENV ?? 'development';
    return (['production', 'preview', 'development', 'test'].includes(v) ? v : 'development') as
      'production' | 'preview' | 'development' | 'test';
  },
  get databaseUrl() { return required('DATABASE_URL'); },
  get directUrl() { return process.env.DIRECT_URL || required('DATABASE_URL'); },
  get pinPepper() {
    const v = required('PIN_PEPPER');
    if (v.length < 32) throw new Error('PIN_PEPPER must be at least 32 characters.');
    return v;
  },
  get adminSetupToken() { return process.env.ADMIN_SETUP_TOKEN || ''; },
  get cronSecret() { return process.env.CRON_SECRET || ''; },
  get footballProvider(): 'none' | 'api-football' | 'football-data' {
    const v = (process.env.FOOTBALL_PROVIDER || 'none').toLowerCase();
    return v === 'api-football' || v === 'football-data' ? v : 'none';
  },
  get apiFootballKey() { return process.env.API_FOOTBALL_KEY || ''; },
  get footballDataToken() { return process.env.FOOTBALL_DATA_TOKEN || ''; },
  get arsenalTeamId() { return process.env.ARSENAL_TEAM_ID || ''; },
  get footballSeason() { return Number(process.env.FOOTBALL_SEASON || new Date().getUTCFullYear()); },
  get isProduction() { return this.appEnv === 'production'; },
};
