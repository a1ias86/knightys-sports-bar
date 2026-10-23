/**
 * Loads the 32 initial members, opening balances, competitions and default settings.
 * Safe to re-run: never duplicates members, resets PINs or overwrites opening balances.
 * Usage: npm run db:seed
 *        tsx scripts/seed.ts --if-configured   (used by the Vercel build; skips if no DB URL set)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url && process.argv.includes('--if-configured')) {
  console.log('[seed] No DIRECT_URL/DATABASE_URL set: skipping.');
  process.exit(0);
}
if (!url) {
  console.error('[seed] Set DIRECT_URL (or DATABASE_URL).');
  process.exit(1);
}

async function main() {
  const sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql.begin((tx) => tx.unsafe(readFileSync(join(process.cwd(), 'db', 'seed.sql'), 'utf8')));
    const [s] = await sql<{ members: number; admins: number; opening: number }[]>`
      select count(*)::int as members, count(*) filter (where role = 'admin')::int as admins,
             (select coalesce(sum(points), 0)::int from opening_balances) as opening
      from members`;
    console.log(`[seed] OK: ${s.members} members (${s.admins} admins), opening points total ${s.opening}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('[seed] FAILED:', e.message);
  process.exit(1);
});
