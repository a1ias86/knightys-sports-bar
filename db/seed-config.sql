-- Knighty's Sports Bar: reference data. Safe on every deploy: only inserts rows that are missing.
-- Never touches members, balances, fixtures, predictions or points.

insert into competitions (code, name, enabled) values
  ('PL',  'Premier League',          true),
  ('FAC', 'FA Cup',                  false),
  ('EFL', 'EFL Cup',                 false),
  ('UCL', 'UEFA Champions League',   false)
on conflict (code) do nothing;

insert into settings (key, value) values
  ('reveal_predictions_after_kickoff', 'true'::jsonb),
  ('competition_name', '"Arsenal Men''s Prediction League"'::jsonb)
on conflict (key) do nothing;

