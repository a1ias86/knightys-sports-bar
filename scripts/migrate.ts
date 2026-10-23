/**
 * Applies db/migrations/*.sql in order, each in its own transaction, recording them in schema_migrations.
 *
 * Safety:
 *  - Already-applied migrations are skipped; an edited applied migration is reported (checksum mismatch).
 *  - Each migration takes a transaction-scoped advisory lock and re-checks schema_migrations, so two builds
 *    running at once can't apply the same migration twice. Works through either Supabase pooler.
 *  - Files containing DROP TABLE / DROP COLUMN / TRUNCATE / DELETE FROM are refused unless the file name
 *    contains ".destructive." AND ALLOW_DESTRUCTIVE_MIGRATIONS=1 is set for that one run, after a backup.
 *
 * Usage: npm run db:migrate            (uses DIRECT_URL, falling back to DATABASE_URL)
 *        tsx scripts/migrate.ts --if-configured   (used by the Vercel build; skips if no DB URL set)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connectForScript } from './db-connect';

const ifConfigured = process.argv.includes('--if-configured');
const DESTRUCTIVE = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|drop\s+schema)\b/i;
const dir = join(process.cwd(), 'db', 'migrations');

async function main() {
  const sql = await connectForScript('migrate');
  if (!sql) {
    if (ifConfigured) {
      console.log('[migrate] No DIRECT_URL/DATABASE_URL set: skipping migrations.');
      return;
    }
    throw new Error('Set DIRECT_URL (or DATABASE_URL).');
  }
  try {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(727274)`;
      await tx`create table if not exists schema_migrations (
        version text primary key, checksum text not null, applied_at timestamptz not null default now())`;
      await tx`alter table schema_migrations enable row level security`;
    });
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const file of files) {
      const body = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const stripped = body.replace(/--.*$/gm, '');
      const applied = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(727274)`;
        const [row] = await tx<{ checksum: string }[]>`select checksum from schema_migrations where version = ${file}`;
        if (row) {
          if (row.checksum !== checksum) console.warn(`[migrate] WARNING: ${file} was edited after being applied. Create a new migration instead.`);
          return false;
        }
        if (DESTRUCTIVE.test(stripped) && (!file.includes('.destructive.') || process.env.ALLOW_DESTRUCTIVE_MIGRATIONS !== '1')) {
          throw new Error(`${file} contains a destructive statement. Back up the database, rename it *.destructive.sql and run with ALLOW_DESTRUCTIVE_MIGRATIONS=1.`);
        }
        console.log(`[migrate] applying ${file}`);
        await tx.unsafe(body);
        await tx`insert into schema_migrations (version, checksum) values (${file}, ${checksum})`;
        return true;
      });
      if (applied) ran++;
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
