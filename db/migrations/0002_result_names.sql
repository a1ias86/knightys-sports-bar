-- Official first goalscorer / first assister are now recorded as names (free text), and each can be in one
-- of four explicit states. Scoring compares names, not player-list ids. Additive: no data is removed.
--
--   player   a named player
--   none     confirmed: no qualifying goal (scorer) / no credited assist (assister)
--   unknown  the information isn't available (e.g. the source doesn't record it)
--   pending  not entered yet
-- Only 'player' and 'none' can be scored; 'unknown' and 'pending' hold the match for an admin.

alter table match_results add column if not exists first_scorer_name text;
alter table match_results add column if not exists first_assister_name text;
-- Admin has reviewed near-miss names (e.g. "Odegaard" v "Ødegaard") and confirmed exact matching only.
alter table match_results add column if not exists name_review_confirmed boolean not null default false;

-- Carry existing results over from the player-list ids.
update match_results r set first_scorer_name = p.name
  from players p where p.id = r.first_scorer_player_id and r.first_scorer_name is null;
update match_results r set first_assister_name = p.name
  from players p where p.id = r.first_assister_player_id and r.first_assister_name is null;

-- Replace the old checks (which tied 'player' to a player id) with name-based ones.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.match_results'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%first_scorer_kind%' or pg_get_constraintdef(oid) like '%first_assister_kind%')
  loop
    execute format('alter table public.match_results drop constraint %I', c.conname);
  end loop;
end $$;

alter table match_results
  add constraint match_results_scorer_kind_chk check (first_scorer_kind in ('player', 'none', 'unknown', 'pending')),
  add constraint match_results_assister_kind_chk check (first_assister_kind in ('player', 'none', 'unknown', 'pending')),
  add constraint match_results_scorer_name_chk check ((first_scorer_kind = 'player') = (coalesce(length(first_scorer_name), 0) > 0)),
  add constraint match_results_assister_name_chk check ((first_assister_kind = 'player') = (coalesce(length(first_assister_name), 0) > 0));

-- Snapshot of exactly what was compared for each member, so every award can be audited later.
alter table fixture_scores add column if not exists predicted_arsenal_goals integer;
alter table fixture_scores add column if not exists predicted_opponent_goals integer;
alter table fixture_scores add column if not exists predicted_scorer text;    -- player name or '(none)'
alter table fixture_scores add column if not exists predicted_assister text;  -- player name or '(none)'
alter table fixture_scores add column if not exists official_scorer text;     -- name, '(none)' or '(void)'
alter table fixture_scores add column if not exists official_assister text;
alter table fixture_scores add column if not exists actual_arsenal_goals integer;
alter table fixture_scores add column if not exists actual_opponent_goals integer;
