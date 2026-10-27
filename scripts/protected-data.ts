/**
 * The league's protected data: everything that decides the current table and its history.
 *
 * Used by:
 *  - migrate.ts / seed.ts: fingerprint before and after every change inside the same transaction; any difference
 *    rolls the change back and fails the deploy.
 *  - league-snapshot.ts: a READ-ONLY JSON snapshot (baseline) and a later comparison against it.
 *
 * Only columns that already exist are read, so adding new columns never counts as a change.
 */

export type Runner = (text: string) => Promise<Record<string, unknown>[]>;

export interface ProtectedSet {
  name: string;
  /** Table or view. */
  from: string;
  /** Columns to protect, in order; any not yet present in the database are ignored. */
  columns: string[];
  /** Columns identifying a row, for readable comparisons. */
  key: string[];
}

export const PROTECTED: ProtectedSet[] = [
  { name: 'league totals', from: 'member_totals', key: ['member_id'],
    columns: ['member_id', 'display_name', 'is_active', 'opening_points', 'match_points', 'adjustment_points', 'total_points'] },
  { name: 'members', from: 'members', key: ['id'], columns: ['id', 'display_name', 'role', 'is_active'] },
  { name: 'opening balances', from: 'opening_balances', key: ['member_id'], columns: ['member_id', 'points', 'source'] },
  { name: 'manual adjustments', from: 'point_adjustments', key: ['id'],
    columns: ['id', 'member_id', 'points', 'reason', 'fixture_id', 'created_by', 'created_at'] },
  { name: 'match points', from: 'fixture_scores', key: ['fixture_id', 'member_id'],
    columns: ['fixture_id', 'member_id', 'prediction_id', 'scorer_points', 'scorer_outcome', 'assister_points', 'assister_outcome',
      'result_points', 'total_goals_points', 'bonus_points', 'total_points', 'scoring_run_id', 'calculated_at',
      'predicted_arsenal_goals', 'predicted_opponent_goals', 'predicted_scorer', 'predicted_assister',
      'official_scorer', 'official_assister', 'actual_arsenal_goals', 'actual_opponent_goals'] },
  { name: 'scoring history', from: 'scoring_runs', key: ['id'], columns: ['id', 'fixture_id', 'trigger', 'status', 'outcome', 'message', 'created_at'] },
  { name: 'fixture scoring state', from: 'fixtures', key: ['id'],
    columns: ['id', 'opponent', 'venue', 'kickoff_at', 'status', 'scoring_status', 'competition_code', 'season'] },
  { name: 'match results', from: 'match_results', key: ['fixture_id'],
    columns: ['fixture_id', 'arsenal_goals', 'opponent_goals', 'source', 'first_scorer_kind', 'first_scorer_name', 'first_scorer_player_id',
      'first_assister_kind', 'first_assister_name', 'first_assister_player_id', 'first_scorer_replaced_name', 'first_assister_replaced_name',
      'first_goal_own_goal', 'first_goal_unassisted', 'player_categories_void', 'verified', 'updated_at'] },
  { name: 'predictions', from: 'predictions', key: ['fixture_id', 'member_id'],
    columns: ['id', 'fixture_id', 'member_id', 'arsenal_goals', 'opponent_goals', 'scorer_name', 'scorer_player_id', 'scorer_none',
      'assister_name', 'assister_player_id', 'assister_none', 'submitted_at', 'updated_at', 'override_reason'] },
];

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Bad identifier ${s}`);
  return `"${s}"`;
};

/** Which of each set's columns exist right now. Sets whose table/view doesn't exist are omitted. */
export async function presentColumns(run: Runner): Promise<Map<string, string[]>> {
  const rows = await run(`
    select table_name as t, column_name as c from information_schema.columns
    where table_schema = 'public'`);
  const have = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = String(r.t ?? r['t']);
    if (!have.has(t)) have.set(t, new Set());
    have.get(t)!.add(String(r.c ?? r['c']));
  }
  const out = new Map<string, string[]>();
  for (const p of PROTECTED) {
    const cols = have.get(p.from);
    if (!cols) continue;
    out.set(p.name, p.columns.filter((c) => cols.has(c)));
  }
  return out;
}

export interface Fingerprint { name: string; rows: number; hash: string }

/** One hash per protected set, over the given columns. Read-only. */
export async function fingerprint(run: Runner, columns: Map<string, string[]>): Promise<Fingerprint[]> {
  const out: Fingerprint[] = [];
  for (const p of PROTECTED) {
    const cols = columns.get(p.name);
    if (!cols || !cols.length) continue;
    const tuple = cols.map(ident).join(', ');
    const [r] = await run(`
      select count(*)::int as n, md5(coalesce(string_agg(x, E'\\n' order by x), '')) as h
      from (select row(${tuple})::text as x from public.${ident(p.from)}) s`);
    out.push({ name: p.name, rows: Number(r.n), hash: String(r.h) });
  }
  return out;
}

export function diffFingerprints(before: Fingerprint[], after: Fingerprint[]): string[] {
  const a = new Map(after.map((f) => [f.name, f]));
  return before
    .filter((b) => !a.has(b.name) || a.get(b.name)!.hash !== b.hash)
    .map((b) => `${b.name}: ${b.rows} row(s) before, ${a.get(b.name)?.rows ?? 'missing'} after`);
}

/** Full rows for a readable baseline file. Read-only. */
export async function snapshotRows(run: Runner, columns: Map<string, string[]>) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const p of PROTECTED) {
    const cols = columns.get(p.name);
    if (!cols || !cols.length) continue;
    const order = p.key.filter((k) => cols.includes(k)).map(ident).join(', ') || '1';
    const rows = await run(`select ${cols.map(ident).join(', ')} from public.${ident(p.from)} order by ${order}`);
    out[p.name] = rows.map((r) => JSON.parse(JSON.stringify(r)));
  }
  return out;
}

/** Competition-ranked positions for active members (same rule as the site's table). */
export function positions(totals: Record<string, unknown>[]): { name: string; points: number; position: number }[] {
  const rows = totals
    .filter((t) => t.is_active !== false)
    .map((t) => ({ name: String(t.display_name), points: Number(t.total_points) }))
    .sort((x, y) => y.points - x.points || x.name.localeCompare(y.name));
  let lastPts: number | null = null;
  let lastPos = 0;
  return rows.map((r, i) => {
    const position = lastPts !== null && r.points === lastPts ? lastPos : i + 1;
    lastPts = r.points;
    lastPos = position;
    return { ...r, position };
  });
}
