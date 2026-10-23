/**
 * Writes a JSON backup of the competition to exports/ (git-ignored). Excludes PIN hashes.
 * Usage: DATABASE_URL=... npm run export
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { exportCompetition } from '../src/lib/export';
import { closeDb } from '../src/lib/db';

async function main() {
  const data = await exportCompetition();
  mkdirSync('exports', { recursive: true });
  const file = `exports/knightys-backup-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[export] wrote ${file}`);
}

main().catch((e) => { console.error('[export] FAILED:', e.message); process.exitCode = 1; }).finally(() => closeDb());
