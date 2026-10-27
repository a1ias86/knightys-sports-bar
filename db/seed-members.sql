-- Knighty's Sports Bar: the initial 32 members, admins and opening balances.
-- Runs ONLY on an empty database (scripts/seed.ts checks first). It is never re-run against a live league,
-- so renamed members, changed roles and corrected balances are never recreated or overwritten.

drop table if exists pg_temp.seed_roster;
create temporary table seed_roster (name text, role text, opening int);
insert into seed_roster (name, role, opening) values
  ('James',    'member', 55), ('Margaret', 'member', 54), ('Jon',      'admin',  50),
  ('Steff',    'member', 48), ('Charlie',  'member', 42), ('Roxy',     'member', 42),
  ('Brett',    'member', 41), ('Prudy',    'member', 37), ('Jackson',  'member', 37),
  ('Neal',     'member', 37), ('Austin',   'member', 36), ('Ross',     'member', 35),
  ('Knighty',  'admin',  35), ('Nadav',    'member', 34), ('Geoff',    'member', 33),
  ('Mark D',   'member', 33), ('Mark P',   'member', 32), ('Liam',     'member', 30),
  ('Henry',    'member', 30), ('Brooksy',  'member', 30), ('Tipple',   'member', 30),
  ('Gareth',   'member', 28), ('Mike',     'member', 27), ('Taraq',    'member', 24),
  ('Tesh',     'member', 21), ('Naythan',  'member', 21), ('Bob',      'member', 20),
  ('Greg',     'member', 18), ('Tony',     'member', 18), ('Ant',      'member', 17),
  ('Marc T',   'member', 16), ('Jake',     'member', 1);

insert into members (display_name, role)
select name, role from seed_roster
on conflict ((lower(display_name))) do nothing;

insert into opening_balances (member_id, points, source)
select m.id, r.opening, 'Imported league table (screenshot supplied at launch)'
from seed_roster r join members m on lower(m.display_name) = lower(r.name)
on conflict (member_id) do nothing;

drop table pg_temp.seed_roster;

-- Jon and Knighty are the administrators (and also compete as members).
update members set role = 'admin', updated_at = now()
where lower(display_name) in ('jon', 'knighty') and role <> 'admin';

insert into audit_log (actor_label, action, details)
select 'system', 'seed.initialised', jsonb_build_object('members', (select count(*) from members))
where not exists (select 1 from audit_log where action = 'seed.initialised');
