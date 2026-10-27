/**
 * READ-ONLY league baseline: saves the table (names, points, positions) and every protected record to a JSON
 * file, or compares the database with a saved file. Never writes to the database (read-only transaction).
 *
 *   npm run league:snapshot                        → exports/league-baseline-<time>.json
 *   npm run league:snapshot -- --compare <file>    → lists every difference; exits 1 if anything changed
 *
 * Uses DIRECT_URL, falling back to DATABASE_URL.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connectForScript } from './db-connect';
import { PROTECTED, presentColumns, snapshotRows, positions, type Runner } from './protected-data';

async function main() {
  const compareIdx = process.argv.indexOf('--compare');
  const compareFile = compareIdx > 0 ? process.argv[compareIdx + 1] : null;
  const sql = await connectForScript('snapshot');
  if (!sql) throw new Error('Set DIRECT_URL (or DATABASE_URL).');
  try {
    const current = await sql.begin(async (tx) => {
      await tx`set transaction read only`;
      const run: Runner = (text) => tx.unsafe(text) as unknown as Promise<Record<string, unknown>[]>;
      const cols = await presentColumns(run);
      const data = await snapshotRows(run, cols);
      return { takenAt: new Date().toISOString(), table: positions(data['league totals'] ?? []), data };
    });

    if (!compareFile) {
      mkdirSync('exports', { recursive: true });
      const file = `exports/league-baseline-${current.takenAt.replace(/[:.]/g, '-')}.json`;
      writeFileSync(file, JSON.stringify(current, null, 2));
      console.log(`[snapshot] saved ${file}`);
      for (const r of current.table) console.log(`  ${String(r.position).padStart(2)}  ${r.name.padEnd(12)} ${r.points}`);
      return;
    }

    const base = JSON.parse(readFileSync(compareFile, 'utf8')) as typeof current;
    const problems: string[] = [];
    const tableNow = new Map(current.table.map((r) => [r.name, r]));
    for (const r of base.table) {
      const n = tableNow.get(r.name);
      if (!n) problems.push(`table: ${r.name} is missing`);
      else if (n.points !== r.points || n.position !== r.position) problems.push(`table: ${r.name} was ${r.points} pts (${r.position}), now ${n.points} pts (${n.position})`);
    }
    for (const r of current.table) if (!base.table.some((b) => b.name === r.name)) problems.push(`table: ${r.name} is new (${r.points} pts)`);

    for (const p of PROTECTED) {
      const was = base.data[p.name] ?? [];
      const now = current.data[p.name] ?? [];
      const key = (row: Record<string, unknown>) => p.key.map((k) => String(row[k])).join('|');
      // Compare only the columns that existed in the baseline.
      const pick = (row: Record<string, unknown>, like: Record<string, unknown>) => JSON.stringify(Object.keys(like).map((k) => row[k]));
      const nowBy = new Map(now.map((r) => [key(r), r]));
      for (const r of was) {
        const n = nowBy.get(key(r));
        if (!n) problems.push(`${p.name}: row ${key(r)} is missing`);
        else if (pick(n, r) !== pick(r, r)) problems.push(`${p.name}: row ${key(r)} changed`);
      }
      const wasKeys = new Set(was.map(key));
      const added = now.filter((r) => !wasKeys.has(key(r))).length;
      if (added) console.log(`[snapshot] note: ${added} new ${p.name} row(s) since the baseline`);
    }

    if (problems.length) {
      console.error(`[snapshot] ${problems.length} difference(s) from ${compareFile}:`);
      for (const p of problems) console.error('  - ' + p);
      process.exitCode = 1;
    } else {
      console.log(`[snapshot] no protected data has changed since ${base.takenAt}. Table positions and points identical.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error('[snapshot] FAILED:', e.message); process.exit(1); });
