-- Knighty's Sports Bar: initial schema
-- PostgreSQL 15+ (Supabase / Neon / local). Applied by scripts/migrate.ts inside a transaction.

-- ─────────────────────────────────────────────────────────────
-- Members & authentication
-- ─────────────────────────────────────────────────────────────
create table members (
  id                   uuid primary key default gen_random_uuid(),
  display_name         text not null check (length(trim(display_name)) between 1 and 40),
  role                 text not null default 'member' check (role in ('member', 'admin')),
  is_active            boolean not null default true,
  -- HMAC-SHA256(PIN_PEPPER, pin). Never the PIN itself. Null until a PIN is issued.
  pin_hash             text,
  pin_set_at           timestamptz,
  failed_pin_attempts  integer not null default 0,
  lockout_count        integer not null default 0,
  locked_until         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index members_display_name_uq on members (lower(display_name));
create unique index members_pin_hash_uq on members (pin_hash) where pin_hash is not null;

create table opening_balances (
  member_id    uuid primary key references members(id) on delete restrict,
  points       integer not null,
  source       text not null default 'Imported league table',
  recorded_at  timestamptz not null default now()
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,          -- sha256 of the cookie token
  member_id     uuid not null references members(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
create index sessions_member_idx on sessions (member_id);

create table login_attempts (
  id          bigserial primary key,
  member_id   uuid references members(id) on delete set null,
  ip          text not null,
  success     boolean not null,
  created_at  timestamptz not null default now()
);
create index login_attempts_ip_time_idx on login_attempts (ip, created_at desc);
create index login_attempts_time_idx on login_attempts (created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Competitions, players, fixtures
-- ─────────────────────────────────────────────────────────────
create table competitions (
  code        text primary key,               -- e.g. PL, FAC, EFL, UCL
  name        text not null,
  enabled     boolean not null default false, -- included in prediction league
  created_at  timestamptz not null default now()
);

create table players (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'manual',
  provider_player_id  text,
  name                text not null,
  team_name           text not null,          -- 'Arsenal' or opponent name
  is_arsenal          boolean not null default false,
  position            text,
  shirt_number        integer,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index players_provider_uq on players (provider, provider_player_id) where provider_player_id is not null;
create unique index players_manual_uq on players (lower(name), lower(team_name)) where provider = 'manual';
create index players_team_idx on players (lower(team_name)) where active;

create table fixtures (
  id                    uuid primary key default gen_random_uuid(),
  provider              text,                     -- null for manually created fixtures
  provider_fixture_id   text,
  competition_code      text not null references competitions(code),
  season                text not null,            -- e.g. '2026-27'
  round                 text not null default '',
  opponent              text not null,
  opponent_provider_id  text,
  venue                 text not null check (venue in ('H', 'A', 'N')),
  kickoff_at            timestamptz not null,      -- stored in UTC; displayed Europe/London
  status                text not null default 'scheduled'
                        check (status in ('scheduled', 'postponed', 'live', 'finished', 'abandoned', 'cancelled')),
  scoring_status        text not null default 'not_ready'
                        check (scoring_status in ('not_ready', 'awaiting_verification', 'review_required', 'finalised', 'void')),
  data_source           text not null default 'manual' check (data_source in ('automatic', 'manual')),
  -- Set when an admin edits kickoff/status by hand; sync will not overwrite those fields.
  manual_override       boolean not null default false,
  review_reason         text,
  last_synced_at        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index fixtures_provider_uq on fixtures (provider, provider_fixture_id) where provider_fixture_id is not null;
-- Natural-key guard against the same match being added twice (manually or by two providers).
create unique index fixtures_natural_uq on fixtures (competition_code, season, round, lower(opponent), venue)
  where status <> 'cancelled';
create index fixtures_kickoff_idx on fixtures (kickoff_at);

create table fixture_lineups (
  fixture_id  uuid not null references fixtures(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  side        text not null check (side in ('arsenal', 'opponent')),
  role        text not null check (role in ('starter', 'substitute')),
  source      text not null default 'automatic',
  updated_at  timestamptz not null default now(),
  primary key (fixture_id, player_id)
);

-- ─────────────────────────────────────────────────────────────
-- Predictions
-- ─────────────────────────────────────────────────────────────
create table predictions (
  id                  uuid primary key default gen_random_uuid(),
  fixture_id          uuid not null references fixtures(id) on delete restrict,
  member_id           uuid not null references members(id) on delete restrict,
  arsenal_goals       integer not null check (arsenal_goals between 0 and 20),
  opponent_goals      integer not null check (opponent_goals between 0 and 20),
  -- Exactly one of: a player, or the special 'none' choice.
  scorer_player_id    uuid references players(id),
  scorer_none         boolean not null default false,
  assister_player_id  uuid references players(id),
  assister_none       boolean not null default false,
  submitted_at        timestamptz not null default now(),   -- first submission
  updated_at          timestamptz not null default now(),   -- last edit
  override_by         uuid references members(id),
  override_reason     text,
  override_at         timestamptz,
  unique (fixture_id, member_id),
  check ((scorer_player_id is null) <> (not scorer_none)),
  check ((assister_player_id is null) <> (not assister_none)),
  check (not scorer_none or (arsenal_goals = 0 and opponent_goals = 0))
);
create index predictions_member_idx on predictions (member_id);

-- ─────────────────────────────────────────────────────────────
-- Results & events
-- ─────────────────────────────────────────────────────────────
-- The authoritative result used for scoring (one per fixture).
create table match_results (
  fixture_id        uuid primary key references fixtures(id) on delete restrict,
  arsenal_goals     integer not null check (arsenal_goals >= 0),
  opponent_goals    integer not null check (opponent_goals >= 0),
  source            text not null check (source in ('automatic', 'manual')),
  -- The settled "first goal" facts used for scoring (see src/lib/scoring.ts for definitions).
  first_scorer_kind         text not null default 'unknown' check (first_scorer_kind in ('player', 'none', 'unknown')),
  first_scorer_player_id    uuid references players(id),
  first_assister_kind       text not null default 'unknown' check (first_assister_kind in ('player', 'none', 'unknown')),
  first_assister_player_id  uuid references players(id),
  first_goal_own_goal       boolean not null default false,
  first_goal_unassisted     boolean not null default false,
  -- Admin decision to finalise without reliable scorer/assister data: those categories score 0 for everyone.
  player_categories_void    boolean not null default false,
  void_reason               text,
  issues                    jsonb not null default '[]'::jsonb,
  verified          boolean not null default false,  -- an admin has confirmed it
  verified_by       uuid references members(id),
  verified_at       timestamptz,
  notes_private     text,                            -- admin-only
  public_note       text,
  updated_at        timestamptz not null default now(),
  check ((first_scorer_kind = 'player') = (first_scorer_player_id is not null)),
  check ((first_assister_kind = 'player') = (first_assister_player_id is not null))
);

-- Latest snapshot from the provider, kept separately so verified manual data is never overwritten.
create table feed_results (
  fixture_id      uuid primary key references fixtures(id) on delete cascade,
  provider        text not null,
  arsenal_goals   integer,
  opponent_goals  integer,
  status          text,
  events          jsonb not null default '[]'::jsonb,
  fetched_at      timestamptz not null default now(),
  discrepancy     text
);

-- Ordered goal/substitution events for the authoritative result.
create table match_events (
  id                  uuid primary key default gen_random_uuid(),
  fixture_id          uuid not null references fixtures(id) on delete cascade,
  source              text not null check (source in ('automatic', 'manual')),
  dedupe_key          text not null,                  -- provider id or deterministic hash
  seq                 integer not null,               -- 1-based chronological order
  minute              integer,
  extra_minute        integer,
  event_type          text not null check (event_type in ('goal', 'own_goal', 'substitution')),
  side                text not null check (side in ('arsenal', 'opponent')),  -- team credited with the goal
  player_id           uuid references players(id),
  player_name         text,
  assist_status       text not null default 'none' check (assist_status in ('credited', 'unassisted', 'unknown', 'none')),
  assist_player_id    uuid references players(id),
  assist_name         text,
  created_at          timestamptz not null default now(),
  unique (fixture_id, source, dedupe_key)
);
create index match_events_fixture_idx on match_events (fixture_id, source, seq);

-- ─────────────────────────────────────────────────────────────
-- Scoring
-- ─────────────────────────────────────────────────────────────
create table scoring_runs (
  id            uuid primary key default gen_random_uuid(),
  fixture_id    uuid not null references fixtures(id) on delete cascade,
  triggered_by  uuid references members(id),
  trigger       text not null,                  -- 'manual_result', 'cron', 'recalculate', ...
  status        text not null check (status in ('success', 'error', 'blocked')),
  outcome       jsonb,                          -- the match outcome used
  message       text,
  created_at    timestamptz not null default now()
);

create table fixture_scores (
  fixture_id         uuid not null references fixtures(id) on delete restrict,
  member_id          uuid not null references members(id) on delete restrict,
  prediction_id      uuid not null references predictions(id) on delete restrict,
  scorer_points      integer not null,
  scorer_outcome     text not null,
  assister_points    integer not null,
  assister_outcome   text not null,
  result_points      integer not null,
  total_goals_points integer not null,
  bonus_points       integer not null,
  total_points       integer not null,
  scoring_run_id     uuid not null references scoring_runs(id),
  calculated_at      timestamptz not null default now(),
  primary key (fixture_id, member_id),
  check (total_points = scorer_points + assister_points + result_points + total_goals_points + bonus_points)
);

create table point_adjustments (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete restrict,
  points      integer not null check (points <> 0),
  reason      text not null check (length(trim(reason)) >= 3),
  fixture_id  uuid references fixtures(id),
  created_by  uuid not null references members(id),
  created_at  timestamptz not null default now()
);
create index point_adjustments_member_idx on point_adjustments (member_id);

-- ─────────────────────────────────────────────────────────────
-- Operations
-- ─────────────────────────────────────────────────────────────
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references members(id),
  updated_at  timestamptz not null default now()
);

create table sync_runs (
  id           uuid primary key default gen_random_uuid(),
  job          text not null,
  provider     text,
  status       text not null check (status in ('success', 'error', 'skipped')),
  message      text,
  details      jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index sync_runs_job_time_idx on sync_runs (job, started_at desc);

-- Lease-based job locks (work with Supabase's transaction pooler, unlike session advisory locks).
create table job_locks (
  job           text primary key,
  locked_until  timestamptz not null,
  holder        text not null
);

create table audit_log (
  id               bigserial primary key,
  actor_member_id  uuid references members(id),
  actor_label      text not null,
  action           text not null,
  entity_type      text,
  entity_id        text,
  details          jsonb,
  created_at       timestamptz not null default now()
);
create index audit_log_time_idx on audit_log (created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Leaderboard view: opening + finalised match points + adjustments
-- ─────────────────────────────────────────────────────────────
create view member_totals as
select
  m.id as member_id,
  m.display_name,
  m.is_active,
  coalesce(ob.points, 0) as opening_points,
  coalesce(fs.points, 0) as match_points,
  coalesce(pa.points, 0) as adjustment_points,
  coalesce(ob.points, 0) + coalesce(fs.points, 0) + coalesce(pa.points, 0) as total_points
from members m
left join opening_balances ob on ob.member_id = m.id
left join (
  select s.member_id, sum(s.total_points)::int as points
  from fixture_scores s join fixtures f on f.id = s.fixture_id
  where f.scoring_status = 'finalised'
  group by s.member_id
) fs on fs.member_id = m.id
left join (select member_id, sum(points)::int as points from point_adjustments group by member_id) pa
  on pa.member_id = m.id;

-- ─────────────────────────────────────────────────────────────
-- Supabase hardening: all access is server-side via the database connection.
-- Enable RLS with no policies so the public REST API (anon / authenticated roles) can read nothing.
-- ─────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
  end if;
end $$;
