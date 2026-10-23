import { sql } from './db';

/**
 * Backup export of the competition. Deliberately excludes PIN hashes, sessions and login attempts.
 */
export async function exportCompetition() {
  const [members, openingBalances, competitions, players, fixtures, predictions, results, events, scores, adjustments, settings, audit] = await Promise.all([
    sql`select id, display_name, role, is_active, created_at from members order by lower(display_name)`,
    sql`select member_id, points, source, recorded_at from opening_balances`,
    sql`select code, name, enabled from competitions`,
    sql`select id, provider, provider_player_id, name, team_name, is_arsenal, position, active from players`,
    sql`select id, provider, provider_fixture_id, competition_code, season, round, opponent, venue, kickoff_at, status, scoring_status, data_source from fixtures order by kickoff_at`,
    sql`select id, fixture_id, member_id, arsenal_goals, opponent_goals, scorer_name, scorer_none, assister_name, assister_none, submitted_at, updated_at, override_by, override_reason, override_at from predictions`,
    sql`select fixture_id, arsenal_goals, opponent_goals, source, first_scorer_kind, first_scorer_name, first_scorer_replaced_name, first_assister_kind, first_assister_name, first_assister_replaced_name, first_goal_own_goal, first_goal_unassisted, player_categories_void, void_reason, verified, verified_by, verified_at, public_note, updated_at from match_results`,
    sql`select fixture_id, source, seq, minute, extra_minute, event_type, side, player_id, player_name, assist_status, assist_player_id, assist_name from match_events`,
    sql`select * from fixture_scores`,
    sql`select id, member_id, points, reason, fixture_id, created_by, created_at from point_adjustments`,
    sql`select key, value, updated_at from settings`,
    sql`select id, actor_label, action, entity_type, entity_id, details, created_at from audit_log order by id`,
  ]);
  const totals = await sql`select member_id, display_name, opening_points, match_points, adjustment_points, total_points from member_totals order by total_points desc`;
  return {
    exportedAt: new Date().toISOString(),
    format: 'knightys-sports-bar-export/v1',
    note: 'PIN hashes, sessions and login attempts are intentionally excluded.',
    totals, members, openingBalances, competitions, players, fixtures, predictions, results, events, scores, adjustments, settings, audit,
  };
}
