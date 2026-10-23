-- Members type their first goalscorer / first assister as free text (no player list).
-- Additive: existing picks are copied into the new name columns; the old id columns stay but are unused.

alter table predictions add column if not exists scorer_name text;
alter table predictions add column if not exists assister_name text;

update predictions p set scorer_name = pl.name
  from players pl where pl.id = p.scorer_player_id and p.scorer_name is null;
update predictions p set assister_name = pl.name
  from players pl where pl.id = p.assister_player_id and p.assister_name is null;

-- Replace the id-based checks with name-based ones.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.predictions'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%scorer_none%' or pg_get_constraintdef(oid) like '%assister_none%')
  loop
    execute format('alter table public.predictions drop constraint %I', c.conname);
  end loop;
end $$;

alter table predictions
  -- exactly one of: a typed name, or the "none" choice
  add constraint predictions_scorer_choice_chk check (scorer_none <> (coalesce(length(scorer_name), 0) > 0)),
  add constraint predictions_assister_choice_chk check (assister_none <> (coalesce(length(assister_name), 0) > 0)),
  add constraint predictions_scorer_name_len_chk check (scorer_name is null or length(scorer_name) <= 60),
  add constraint predictions_assister_name_len_chk check (assister_name is null or length(assister_name) <= 60),
  -- "No goalscorer" only with a 0-0 prediction
  add constraint predictions_no_scorer_nil_nil_chk check (not scorer_none or (arsenal_goals = 0 and opponent_goals = 0));

-- Substitutions: if the official first goalscorer / first assister came on as a substitute, the player they
-- replaced. Members who picked the replaced player score as if they had picked the substitute.
alter table match_results add column if not exists first_scorer_replaced_name text;
alter table match_results add column if not exists first_assister_replaced_name text;
alter table match_results
  add constraint match_results_scorer_replaced_chk check (first_scorer_replaced_name is null or (first_scorer_kind = 'player' and length(first_scorer_replaced_name) between 1 and 60)),
  add constraint match_results_assister_replaced_chk check (first_assister_replaced_name is null or (first_assister_kind = 'player' and length(first_assister_replaced_name) between 1 and 60));
