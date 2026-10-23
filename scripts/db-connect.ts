/**
 * Connection helper for build-time scripts (migrate, seed).
 *
 * Tries DIRECT_URL (Supabase session pooler) first, then DATABASE_URL (transaction pooler). Each attempt is
 * retried a few times, because a busy session pooler ("max clients reached") usually frees up within seconds.
 * Everything the scripts do runs inside single transactions with transaction-scoped locks, so it is safe on
 * either pooler.
 */
import postgres from 'postgres';

export type ScriptSql = postgres.Sql<Record<string, never>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connectForScript(tag: string): Promise<ScriptSql | null> {
  const candidates = [
    ['DIRECT_URL', process.env.DIRECT_URL],
    ['DATABASE_URL', process.env.DATABASE_URL],
  ].filter((c): c is [string, string] => !!c[1]);
  const unique = candidates.filter((c, i) => candidates.findIndex((d) => d[1] === c[1]) === i);
  if (!unique.length) return null;

  let lastError: unknown = null;
  for (const [name, url] of unique) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 20 }) as unknown as ScriptSql;
      try {
        await sql`select 1`;
        if (name !== unique[0][0] || attempt > 1) console.log(`[${tag}] connected via ${name} (attempt ${attempt})`);
        return sql;
      } catch (e) {
        lastError = e;
        await sql.end({ timeout: 1 }).catch(() => {});
        console.warn(`[${tag}] ${name} attempt ${attempt} failed: ${(e as Error).message}`);
        if (attempt < 3) await sleep(5000 * attempt);
      }
    }
  }
  throw lastError;
}
