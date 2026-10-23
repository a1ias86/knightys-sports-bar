/**
 * Applies db/migrations/*.sql in order, each in its own transaction, recording them in schema_migrations.
 *
 * Safety:
 *  - Already-applied migrations are skipped; an edited applied migration is reported (checksum mismatch).
 *  - Files containing DROP TABLE / DROP COLUMN / TRUNCATE / DELETE FROM are refused unless the file name
 *    contains ".destructive." AND ALLOW_DESTRUCTIVE_MIGRATIONS=1 is set for that one run, after a backup.
 *
 * Usage: npm run db:migrate            (uses DIRECT_URL, falling back to DATABASE_URL)
 *        tsx scripts/migrate.ts --if-configured   (used by the Vercel build; skips if no DB URL set)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';

const ifConfigured = process.argv.includes('--if-configured');
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  if (ifConfigured) {
    console.log('[migrate] No DIRECT_URL/DATABASE_URL set: skipping migrations.');
    process.exit(0);
  }
  console.error('[migrate] Set DIRECT_URL (or DATABASE_URL).');
  process.exit(1);
}

const DESTRUCTIVE = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|drop\s+schema)\b/i;
const dir = join(process.cwd(), 'db', 'migrations');

async function main() {
  const sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    await sql`alter table schema_migrations enable row level security`;
    // Serialise concurrent runs (e.g. two deployments building at once).
    await sql`select pg_advisory_lock(727274)`;
    const applied = new Map((await sql<{ version: string; checksum: string }[]>`select version, checksum from schema_migrations`).map((r) => [r.version, r.checksum]));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const file of files) {
      const body = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) console.warn(`[migrate] WARNING: ${file} was edited after being applied. Create a new migration instead.`);
        continue;
      }
      const stripped = body.replace(/--.*$/gm, '');
      if (DESTRUCTIVE.test(stripped)) {
        if (!file.includes('.destructive.') || process.env.ALLOW_DESTRUCTIVE_MIGRATIONS !== '1') {
          throw new Error(`${file} contains a destructive statement. Back up the database, rename it *.destructive.sql and run with ALLOW_DESTRUCTIVE_MIGRATIONS=1.`);
        }
      }
      console.log(`[migrate] applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (version, checksum) values (${file}, ${checksum})`;
      });
      ran++;
    }
    console.log(ran ? `[migrate] applied ${ran} migration(s).` : '[migrate] database is up to date.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('[migrate] FAILED:', e.message);
  process.exit(1);
});
