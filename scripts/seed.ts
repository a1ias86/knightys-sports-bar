/**
 * Database setup data, run on every deploy.
 *
 *  - db/seed-config.sql: competitions and default settings, inserted only if missing.
 *  - db/seed-members.sql: the initial 32 members, admins and opening balances, ONLY when the members table is
 *    empty (first setup). It is never re-run against a live league, so renamed members, changed roles and
 *    corrected balances are never recreated or overwritten.
 *
 * LEAGUE GUARD: on an existing league, the protected data is fingerprinted before and after inside the same
 * transaction; any difference rolls back and fails the deploy.
 *
 * Usage: npm run db:seed
 *        tsx scripts/seed.ts --if-configured   (used by the Vercel build; skips if no DB URL set)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectForScript } from './db-connect';
import { presentColumns, fingerprint, diffFingerprints, type Runner } from './protected-data';

const read = (f: string) => readFileSync(join(process.cwd(), 'db', f), 'utf8');

async function main() {
  const sql = await connectForScript('seed');
  if (!sql) {
    if (process.argv.includes('--if-configured')) {
      console.log('[seed] No DIRECT_URL/DATABASE_URL set: skipping.');
      return;
    }
    throw new Error('Set DIRECT_URL (or DATABASE_URL).');
  }
  try {
    const firstSetup = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(727276)`;
      const run: Runner = (text) => tx.unsafe(text) as unknown as Promise<Record<string, unknown>[]>;
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from members`;
      const cols = await presentColumns(run);
      const before = await fingerprint(run, cols);
      await tx.unsafe(read('seed-config.sql'));
      if (n === 0) {
        await tx.unsafe(read('seed-members.sql'));
        return true;
      }
      const changed = diffFingerprints(before, await fingerprint(run, cols));
      if (changed.length) throw new Error(`setup would change protected league data, so it was rolled back:\n  ${changed.join('\n  ')}`);
      return false;
    });
    const [s] = await sql<{ members: number; admins: number; opening: number }[]>`
      select count(*)::int as members, count(*) filter (where role = 'admin')::int as admins,
             (select coalesce(sum(points), 0)::int from opening_balances) as opening
      from members`;
    console.log(firstSetup
      ? `[seed] first setup: ${s.members} members (${s.admins} admins), opening points total ${s.opening}.`
      : `[seed] existing league left untouched (${s.members} members). Reference data checked.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('[seed] FAILED:', e.message);
  process.exit(1);
});
