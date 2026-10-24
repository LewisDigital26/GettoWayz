-- migration-010: path "I've used this" confirmations, path accessibility tags, bike-theft alerts, badges & streaks.
-- Run once in the Supabase SQL editor, after 002–009. Safe to re-run.
-- Safety features (arrival timer, quick share / SOS) reuse the shares table; section 5 only adds the 'safe' check-in reason.

-- ---------------------------------------------------------------------
-- 1. New alert category: bike theft hotspot (default 14-day expiry from create_alert's fallback)
-- ---------------------------------------------------------------------
alter table alerts drop constraint if exists alerts_category_check;
alter table alerts add constraint alerts_category_check
  check (category in ('blocked','pothole','lighting','closure','flooding','other','light_out','light_ok','street_lit','street_dark','bike_theft'));

-- ---------------------------------------------------------------------
-- 2. Accessibility tags on community paths
-- ---------------------------------------------------------------------
alter table paths add column if not exists access jsonb not null default '{}'::jsonb;

drop function if exists suggest_path(text, text, text, text, jsonb);
create or replace function suggest_path(p_name text, p_type text, p_surface text, p_note text, p_points jsonb, p_access jsonb default '{}'::jsonb)
returns paths language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p paths; len double precision := 0; i int; acc jsonb;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  if jsonb_array_length(p_points) < 2 then raise exception 'Draw at least two points.'; end if;
  for i in 1..jsonb_array_length(p_points) - 1 loop
    len := len + gw_haversine((p_points->(i-1)->>0)::float, (p_points->(i-1)->>1)::float, (p_points->i->>0)::float, (p_points->i->>1)::float);
  end loop;
  if len < 10 then raise exception 'That path is too short to review.'; end if;
  if len > 3000 then raise exception 'Keep suggestions under 3 km — split long paths.'; end if;
  if (select count(*) from paths where created_by = me and created_at::date = current_date) >= 3 then raise exception 'Limit reached: 3 path suggestions per day.'; end if;
  -- only known keys with true/false values are kept
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into acc from jsonb_each(coalesce(p_access, '{}'::jsonb)) as e(k, v)
    where k in ('stepFree','pushchair','cargoBike','droppedKerbs','lit','gated') and jsonb_typeof(v) = 'boolean';
  insert into paths (name, type, surface, note, points, created_by, access)
    values (left(p_name, 60), p_type, p_surface, left(coalesce(p_note, ''), 300), p_points, me, acc) returning * into p;
  return p;
end $$;
revoke execute on function suggest_path(text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function suggest_path(text, text, text, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3. "I've used this path" confirmations (no points — keeps it honest)
-- ---------------------------------------------------------------------
create table if not exists path_confirmations (
  path_id uuid references paths(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  at timestamptz not null default now(),
  still_ok boolean not null default true,      -- false = "it's blocked / gone now"
  primary key (path_id, user_id)
);
alter table path_confirmations enable row level security;
drop policy if exists "path confirmations: read" on path_confirmations;
create policy "path confirmations: read" on path_confirmations for select using (true);

create or replace function confirm_path(p_path uuid, p_still_ok boolean default true) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p paths;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  select * into p from paths where id = p_path;
  if p.id is null or p.status <> 'approved' then raise exception 'Only approved paths can be confirmed.'; end if;
  if p.created_by = me then raise exception 'You can''t confirm your own path.'; end if;
  if (select count(*) from path_confirmations where user_id = me and at::date = current_date) >= 20 then raise exception 'Confirmation limit reached for today.'; end if;
  insert into path_confirmations (path_id, user_id, at, still_ok) values (p_path, me, now(), coalesce(p_still_ok, true))
    on conflict (path_id, user_id) do update set at = now(), still_ok = excluded.still_ok;
end $$;
revoke execute on function confirm_path(uuid, boolean) from public, anon;
grant execute on function confirm_path(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Badges & streaks — computed on the server from data clients can't write directly
--    (verified trips, awarded point entries, path confirmations). Nothing is stored, so nothing can be faked.
-- ---------------------------------------------------------------------
create or replace function my_badges() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  trips int; dist double precision; modes int; hazards int; lights int; paths_ok int; checks int;
  cur int := 0; best int := 0; last_day date;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  select count(*), coalesce(sum(eligible_m), 0), count(distinct mode) filter (where mode <> 'drive')
    into trips, dist, modes from trip_sessions where user_id = me and status = 'completed';
  select count(*) filter (where rule = 'alert_verified'),
         count(*) filter (where rule in ('streetlight_verified','street_lighting_confirmed')),
         count(*) filter (where rule = 'path_approved')
    into hazards, lights, paths_ok from point_entries where user_id = me and status = 'awarded';
  select count(*) into checks from path_confirmations where user_id = me;

  -- streak = consecutive UK days with at least one verified trip (gaps-and-islands)
  with d as (select distinct (finished_at at time zone 'Europe/London')::date as day from trip_sessions where user_id = me and status = 'completed' and finished_at is not null),
       g as (select day, day - (row_number() over (order by day))::int as grp from d),
       runs as (select min(day) as s, max(day) as e, count(*) as n from g group by grp)
  select coalesce(max(n), 0) into best from runs;
  with d as (select distinct (finished_at at time zone 'Europe/London')::date as day from trip_sessions where user_id = me and status = 'completed' and finished_at is not null),
       g as (select day, day - (row_number() over (order by day))::int as grp from d),
       runs as (select max(day) as e, count(*) as n from g group by grp)
  select n, e into cur, last_day from runs order by e desc limit 1;
  if last_day is null or last_day < (now() at time zone 'Europe/London')::date - 1 then cur := 0; end if;

  return jsonb_build_object(
    'streak', jsonb_build_object('current', coalesce(cur, 0), 'best', best, 'lastDay', last_day),
    'stats', jsonb_build_object('trips', trips, 'distanceM', round(dist), 'modes', modes, 'hazards', hazards, 'lights', lights, 'paths', paths_ok, 'pathChecks', checks),
    'badges', jsonb_build_array(
      jsonb_build_object('key', 'first_trip',   'progress', trips,           'target', 1),
      jsonb_build_object('key', 'trips_10',     'progress', trips,           'target', 10),
      jsonb_build_object('key', 'trips_50',     'progress', trips,           'target', 50),
      jsonb_build_object('key', 'km_10',        'progress', round(dist/1000), 'target', 10),
      jsonb_build_object('key', 'km_100',       'progress', round(dist/1000), 'target', 100),
      jsonb_build_object('key', 'streak_3',     'progress', best,            'target', 3),
      jsonb_build_object('key', 'streak_7',     'progress', best,            'target', 7),
      jsonb_build_object('key', 'all_modes',    'progress', modes,           'target', 3),
      jsonb_build_object('key', 'hazard_5',     'progress', hazards,         'target', 5),
      jsonb_build_object('key', 'lights_5',     'progress', lights,          'target', 5),
      jsonb_build_object('key', 'path_1',       'progress', paths_ok,        'target', 1),
      jsonb_build_object('key', 'path_5',       'progress', paths_ok,        'target', 5),
      jsonb_build_object('key', 'checker_10',   'progress', checks,          'target', 10)
    ));
end $$;
revoke execute on function my_badges() from public, anon;
grant execute on function my_badges() to authenticated;

-- ---------------------------------------------------------------------
-- 5. Arrival timer check-in: the traveller can end a timer share as 'safe' (same function as migration-003, plus 'safe')
-- ---------------------------------------------------------------------
create or replace function set_share_status(p_share uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare s shares; r text;
begin
  select * into s from shares where id = p_share;
  if s.id is null or auth.uid() not in (s.from_user, s.to_user) then raise exception 'Not your sharing session.'; end if;
  if p_status = 'ended' then
    if s.status = 'ended' then return; end if;
    if auth.uid() = s.to_user then r := 'left';
    else
      r := case when p_reason in ('stopped','cancelled','arrived','safe') then p_reason else 'stopped' end;
      if r = 'arrived' and not (s.last_lat is not null and s.trip is not null
          and gw_haversine(s.last_lat, s.last_lng, (s.trip->>'destLat')::float, (s.trip->>'destLng')::float) <= 75) then r := 'stopped'; end if;
      if r = 'safe' and (s.trip is null or s.trip->'safety' is null) then r := 'stopped'; end if;  -- only arrival-timer shares check in
    end if;
    update shares set status = 'ended', ended_reason = r, ended_at = now() where id = p_share;
  elsif auth.uid() <> s.from_user then raise exception 'Not your sharing session.';
  elsif p_status = 'paused' then update shares set status = 'paused' where id = p_share and status = 'active' and type = 'location';
  elsif p_status = 'active' then update shares set status = 'active' where id = p_share and status = 'paused' and ends_at > now();
  end if;
end $$;
