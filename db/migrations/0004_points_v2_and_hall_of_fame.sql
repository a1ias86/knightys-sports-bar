-- 20-point scoring for newly scored matches, and the Hall of Fame.
--
-- PROTECTS THE CURRENT LEAGUE: this migration only ADDS things. It updates and deletes no rows.
--  * New columns on fixture_scores have no default, so every existing row reads NULL, meaning "scored under
--    the original 15-point rules". No existing row is rewritten.
--  * The sum check is widened to include the new exact-score column; existing rows (NULL there) already satisfy
--    it. Adding a check only reads rows.
--  * The deploy-time league guard (scripts/migrate.ts) fingerprints all protected league data before and after
--    this file inside the same transaction and rolls it back if anything differs.

alter table fixture_scores add column if not exists rules_version smallint;       -- NULL = original rules (v1)
alter table fixture_scores add column if not exists exact_score_points integer;   -- v2 only

alter table fixture_scores
  add constraint fixture_scores_rules_version_chk check (rules_version is null or rules_version in (1, 2)),
  add constraint fixture_scores_exact_points_chk check (
    (coalesce(rules_version, 1) = 1 and exact_score_points is null)
    or (rules_version = 2 and exact_score_points in (0, 5))),
  add constraint fixture_scores_total_v2_chk check (
    total_points = coalesce(exact_score_points, 0) + scorer_points + assister_points + result_points + total_goals_points + bonus_points);

-- The original total check (without the exact-score column) is replaced by the one above.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.fixture_scores'::regclass and contype = 'c'
      and conname <> 'fixture_scores_total_v2_chk'
      and pg_get_constraintdef(oid) like '%total_points = %'
      and pg_get_constraintdef(oid) not like '%exact_score_points%'
  loop
    execute format('alter table public.fixture_scores drop constraint %I', c.conname);
  end loop;
end $$;

-- ─── Hall of Fame ────────────────────────────────────────────
create table if not exists hall_of_fame (
  id            uuid primary key default gen_random_uuid(),
  season_label  text not null check (season_label ~ '^[0-9]{4}/[0-9]{2}$'),
  season_start  integer not null check (season_start between 1900 and 2200),
  winner_name   text not null check (length(trim(winner_name)) between 1 and 60),
  member_id     uuid references members(id) on delete set null,   -- optional link; winners needn't be members
  points        integer check (points is null or points between 0 and 10000),
  summary       text check (summary is null or length(summary) <= 500),
  created_by    uuid references members(id),
  updated_by    uuid references members(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One champion per season.
create unique index if not exists hall_of_fame_season_uq on hall_of_fame (season_label);
alter table hall_of_fame enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.hall_of_fame from anon, authenticated';
  end if;
end $$;
