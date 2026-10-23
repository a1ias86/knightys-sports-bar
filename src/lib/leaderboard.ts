import { sql } from './db';
import { competitionRank } from './scoring';

export interface LeaderboardRow {
  memberId: string;
  displayName: string;
  openingPoints: number;
  matchPoints: number;
  adjustmentPoints: number;
  totalPoints: number;
  position: number;
  /** Points from the last up-to-5 finalised fixtures, oldest first (null = no prediction). */
  form: (number | null)[];
  /** Positive = moved up since before the most recent finalised fixture. Null when no history yet. */
  movement: number | null;
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const totals = await sql<{ memberId: string; displayName: string; openingPoints: number; matchPoints: number; adjustmentPoints: number; totalPoints: number }[]>`
    select member_id, display_name, opening_points, match_points, adjustment_points, total_points
    from member_totals where is_active`;

  const recent = await sql<{ id: string }[]>`
    select id from fixtures where scoring_status = 'finalised' order by kickoff_at desc limit 5`;
  const recentIds = recent.map((r) => r.id).reverse();

  const scores = recentIds.length
    ? await sql<{ fixtureId: string; memberId: string; totalPoints: number }[]>`
        select fixture_id, member_id, total_points from fixture_scores where fixture_id in ${sql(recentIds)}`
    : [];
  const byKey = new Map(scores.map((s) => [`${s.fixtureId}:${s.memberId}`, s.totalPoints]));

  const ranked = competitionRank(totals, (r) => r.totalPoints);
  let previous: Map<string, number> | null = null;
  if (recentIds.length) {
    const last = recentIds[recentIds.length - 1];
    const prevRanked = competitionRank(totals.map((t) => ({ ...t, prev: t.totalPoints - (byKey.get(`${last}:${t.memberId}`) ?? 0) })), (r) => r.prev);
    previous = new Map(prevRanked.map((r) => [r.memberId, r.position]));
  }

  return ranked.map((r) => ({
    ...r,
    form: recentIds.map((fid) => byKey.get(`${fid}:${r.memberId}`) ?? null),
    movement: previous ? (previous.get(r.memberId)! - r.position) : null,
  }));
}

export async function memberStanding(memberId: string) {
  const board = await getLeaderboard();
  const row = board.find((r) => r.memberId === memberId) ?? null;
  return { row, size: board.length, board };
}
