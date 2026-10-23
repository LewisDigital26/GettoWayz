-- Migration 004 — points policy, auditable ledger, verified trips, levels and leaderboards.
-- Run once in the Supabase SQL editor after schema.sql and migrations 002–003. Safe to re-run.
--
-- Everything that decides points runs here, on the server. Clients never send a points amount.
-- Default values mirror js/backend/pointsPolicy.js. To change live values, edit point_rules / points_settings.

-- =====================================================================
-- 1. Policy (one place, readable by the app for the "How points work" guide)
-- =====================================================================
create table if not exists point_rules (
  key text primary key,
  label text not null,
  grp text not null,
  points int,                         -- null = calculated (e.g. trip distance bands)
  daily_cap int,                      -- per user per UK day; null = no cap
  retired boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table point_rules enable row level security;
drop policy if exists "point_rules: readable" on point_rules;
create policy "point_rules: readable" on point_rules for select using (true);
grant select on point_rules to anon, authenticated;
insert into point_rules (key, label, grp, points, daily_cap, retired) values
  ('path_approved',        'Missing path approved by a moderator',          'Map contributions', 25, 75, false),
  ('alert_verified',       'Hazard report verified by a moderator',         'Map contributions', 8, 40, false),
  ('streetlight_verified', 'Streetlight report verified by a moderator',    'Map contributions', 3, 15, false),
  ('confirm_helpful',      'You confirmed a report that was then verified', 'Map contributions', 2, 10, false),
  ('trip_completed',       'Completed a verified trip',                     'Trips', 4, 16, false),
  ('trip_distance',        'Distance bonus for a verified trip',            'Trips', null, 30, false),
  ('reversal',             'Points reversed by a moderator',                'Adjustments', null, null, false),
  ('alert_confirmed',      'Your report was confirmed by others (retired rule)', 'Retired', 0, null, true),
  ('shared_trip_bonus',    'Shared-trip bonus (retired rule)',              'Retired', 0, null, true)
on conflict (key) do nothing;

create table if not exists points_settings (
  id int primary key default 1 check (id = 1),
  policy_version int not null,
  trip jsonb not null,
  level_curve jsonb not null,
  updated_at timestamptz not null default now()
);
alter table points_settings enable row level security;
drop policy if exists "points_settings: readable" on points_settings;
create policy "points_settings: readable" on points_settings for select using (true);
grant select on points_settings to anon, authenticated;
insert into points_settings (id, policy_version, trip, level_curve) values (1, 2,
  '{"minEligibleM":400,"minProgress":0.8,"arrivalRadiusM":75,"detourFactor":1.4,"minCheckpointGapSec":10,"checkpointsPerKm":1,"maxPerTrip":14,"maxActiveHours":6,
    "bands":[{"minM":400,"points":1},{"minM":1000,"points":3},{"minM":2500,"points":5},{"minM":5000,"points":8},{"minM":8000,"points":10}],
    "modes":{"walk":{"distanceFactor":1.0,"maxSegmentSpeed":4.0,"maxAverageSpeed":2.6,"basePoints":4,"distanceBonus":true},
             "bike":{"distanceFactor":0.5,"maxSegmentSpeed":14,"maxAverageSpeed":9,"basePoints":4,"distanceBonus":true},
             "scooter":{"distanceFactor":0.5,"maxSegmentSpeed":9,"maxAverageSpeed":7,"basePoints":4,"distanceBonus":true},
             "drive":{"distanceFactor":0,"maxSegmentSpeed":45,"maxAverageSpeed":30,"basePoints":2,"distanceBonus":false}}}'::jsonb,
  '{"base":25,"exponent":1.75,"levels":10}'::jsonb)
on conflict (id) do nothing;

-- =====================================================================
-- 2. Profiles: privacy choices + level floor
-- =====================================================================
alter table profiles add column if not exists level_floor int not null default 1;            -- highest level reached; never lowered
alter table profiles add column if not exists friends_board_opt_in boolean not null default false;
alter table profiles add column if not exists trip_points boolean not null default true;      -- send trip checks while navigating

create or replace function gw_level_for(p_points bigint) returns int language sql stable set search_path = public as $$
  select coalesce(max(n), 1)::int from points_settings s, generate_series(1, coalesce((s.level_curve->>'levels')::int, 10)) n
  where p_points >= case when n = 1 then 0 else round((s.level_curve->>'base')::numeric * power(n - 1, (s.level_curve->>'exponent')::numeric) / 5) * 5 end;
$$;

-- =====================================================================
-- 3. Ledger: status, reversals, policy version, idempotency, indexes
-- =====================================================================
alter table point_entries add column if not exists status text not null default 'awarded';
alter table point_entries drop constraint if exists point_entries_status_check;
alter table point_entries add constraint point_entries_status_check check (status in ('awarded','capped','reversed','reversal'));
alter table point_entries add column if not exists points_requested int;
alter table point_entries add column if not exists reversal_of uuid references point_entries(id);
alter table point_entries add column if not exists reason text;
alter table point_entries add column if not exists actor uuid references profiles(id) on delete set null;
alter table point_entries add column if not exists policy_version int;
create unique index if not exists point_entries_one_reversal on point_entries (reversal_of) where reversal_of is not null;
create index if not exists point_entries_user_at on point_entries (user_id, at desc);
create index if not exists point_entries_awarded_at on point_entries (at, user_id) where status = 'awarded';
create index if not exists point_entries_ref on point_entries (ref_type, ref_id);
-- (user_id, rule, ref_id) is already unique → the same event can never be awarded twice, even under retries.

-- Moderator audit log
create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references profiles(id) on delete set null,
  action text not null, target_user uuid, target_ref text, reason text,
  at timestamptz not null default now()
);
alter table admin_actions enable row level security;
drop policy if exists "admin_actions: admins read" on admin_actions;
create policy "admin_actions: admins read" on admin_actions for select using (gw_is_admin());
grant select on admin_actions to authenticated;

-- The ONLY way points are added. Server-side callers pass the event; the amount comes from point_rules
-- unless a server function computed it (trip distance). Idempotent, capped per UK day, serialised per user.
create or replace function gw_award(p_user uuid, p_rule text, p_ref_type text, p_ref_id text, p_points int default null)
returns int language plpgsql security definer set search_path = public as $$
declare r point_rules; pts int; req int; today_pts int; st text := 'awarded'; ver int; new_id uuid; new_total int;
begin
  select * into r from point_rules where key = p_rule;
  if r.key is null or r.retired or p_rule = 'reversal' then return 0; end if;
  req := coalesce(p_points, r.points, 0);
  if req <= 0 or p_user is null or p_ref_id is null then return 0; end if;
  perform 1 from profiles where id = p_user for update;      -- serialise this user's awards (caps + concurrent requests)
  if not found then return 0; end if;                        -- deleted account
  if exists (select 1 from point_entries where user_id = p_user and rule = p_rule and ref_id = p_ref_id) then return 0; end if;
  pts := req;
  if r.daily_cap is not null then
    select coalesce(sum(points), 0) into today_pts from point_entries
      where user_id = p_user and rule = p_rule and status = 'awarded'
        and (at at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date;
    if today_pts >= r.daily_cap then pts := 0; st := 'capped';
    elsif today_pts + pts > r.daily_cap then pts := r.daily_cap - today_pts; end if;
  end if;
  select policy_version into ver from points_settings where id = 1;
  insert into point_entries (user_id, rule, points, ref_type, ref_id, status, points_requested, policy_version)
    values (p_user, p_rule, pts, p_ref_type, p_ref_id, st, req, ver)
    on conflict do nothing returning id into new_id;
  if new_id is null or pts = 0 then return 0; end if;
  update profiles set points = points + pts where id = p_user returning points into new_total;
  update profiles set level_floor = greatest(level_floor, gw_level_for(new_total)) where id = p_user;
  return pts;
end $$;

-- Kept for older server functions: the amount argument is ignored — the policy decides.
create or replace function gw_grant(p_user uuid, p_rule text, p_ref_type text, p_ref_id text, p_points int)
returns void language plpgsql security definer set search_path = public as $$
begin perform gw_award(p_user, p_rule, p_ref_type, p_ref_id, null); end $$;

-- Reverse one award without deleting it: the original is marked "reversed" and a negative "reversal" entry
-- points back to it. The balance drops; the level floor (highest level reached) is kept.
create or replace function gw_reverse_entry(p_entry uuid, p_reason text, p_actor uuid) returns int
language plpgsql security definer set search_path = public as $$
declare e point_entries; ver int;
begin
  select * into e from point_entries where id = p_entry for update;
  if e.id is null or e.status not in ('awarded','capped') or e.rule = 'reversal' then return 0; end if;
  perform 1 from profiles where id = e.user_id for update;
  update point_entries set status = 'reversed' where id = e.id;
  select policy_version into ver from points_settings where id = 1;
  insert into point_entries (user_id, rule, points, ref_type, ref_id, status, reversal_of, reason, actor, policy_version)
    values (e.user_id, 'reversal', -e.points, 'point_entry', e.id::text, 'reversal', e.id, left(p_reason, 300), p_actor, ver);
  if e.points > 0 then update profiles set points = points - e.points where id = e.user_id; end if;
  return e.points;
end $$;

-- Internal helpers must not be callable by app users (Supabase exposes public functions over RPC).
revoke execute on function gw_award(uuid, text, text, text, int) from public, anon, authenticated;
revoke execute on function gw_grant(uuid, text, text, text, int) from public, anon, authenticated;
revoke execute on function gw_reverse_entry(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function gw_end_shares_between(uuid, uuid, text) from public, anon, authenticated;
-- These would let anyone probe whether two other users are friends or have blocked each other.
revoke execute on function gw_are_friends(uuid, uuid) from public, anon, authenticated;
revoke execute on function gw_blocked_either(uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- 4. Contributions: award only on verification
-- =====================================================================
create or replace function confirm_alert(p_alert uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); owner uuid;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  select created_by into owner from alerts where id = p_alert;
  if owner is null then raise exception 'Alert not found.'; end if;
  if owner = me then raise exception 'You can''t confirm your own report.'; end if;
  if (select count(*) from alert_confirmations where user_id = me and at::date = current_date) >= 20 then raise exception 'Confirmation limit reached for today.'; end if;
  insert into alert_confirmations (alert_id, user_id) values (p_alert, me) on conflict do nothing;
  if not found then raise exception 'Already confirmed.'; end if;
  -- No points here: confirmations only count if a moderator later verifies the report.
end $$;

create or replace function review_alert(p_alert uuid, p_decision text) returns void language plpgsql security definer set search_path = public as $$
declare a alerts; c record;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into a from alerts where id = p_alert;
  if a.id is null then raise exception 'Alert not found.'; end if;
  if p_decision = 'verify' and a.status <> 'verified' then
    update alerts set status = 'verified', reviewed_at = now() where id = p_alert;
    perform gw_award(a.created_by, case when a.category in ('light_out','light_ok') then 'streetlight_verified' else 'alert_verified' end, 'alert', p_alert::text);
    for c in select user_id from alert_confirmations where alert_id = p_alert loop perform gw_award(c.user_id, 'confirm_helpful', 'alert', p_alert::text); end loop;
  elsif p_decision = 'reject' then update alerts set status = 'rejected', reviewed_at = now() where id = p_alert;
  elsif p_decision = 'resolve' then update alerts set status = 'resolved', reviewed_at = now() where id = p_alert;
  end if;
  insert into admin_actions (admin_id, action, target_user, target_ref) values (auth.uid(), 'alert_' || p_decision, a.created_by, 'alert:' || p_alert);
end $$;

create or replace function review_path(p_path uuid, p_decision text, p_message text) returns void language plpgsql security definer set search_path = public as $$
declare p paths;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into p from paths where id = p_path;
  if p.id is null then raise exception 'Path not found.'; end if;
  if p_decision = 'approve' then
    update paths set status = 'approved', reviewed_at = now(), review_message = left(coalesce(p_message, ''), 300) where id = p_path;
    perform gw_award(p.created_by, 'path_approved', 'path', p_path::text);
  else
    update paths set status = case p_decision when 'reject' then 'rejected' else 'changes' end, reviewed_at = now(), review_message = left(coalesce(p_message, ''), 300) where id = p_path;
  end if;
  insert into admin_actions (admin_id, action, target_user, target_ref, reason) values (auth.uid(), 'path_' || p_decision, p.created_by, 'path:' || p_path, left(p_message, 300));
end $$;

-- Own contributions with their verification + award status (rejected ones included — they are yours).
create or replace function my_contributions(p_limit int default 30) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'createdAt' desc), '[]'::jsonb) from (
    (select jsonb_build_object('kind', 'alert', 'id', a.id, 'category', a.category, 'status', a.status, 'createdAt', a.created_at,
      'award', (select jsonb_build_object('status', e.status, 'points', e.points) from point_entries e where e.user_id = auth.uid() and e.ref_type = 'alert' and e.ref_id = a.id::text and e.rule in ('alert_verified','streetlight_verified') limit 1)) as x
      from alerts a where a.created_by = auth.uid() order by a.created_at desc limit least(greatest(p_limit, 1), 50))
    union all
    (select jsonb_build_object('kind', 'path', 'id', p.id, 'name', p.name, 'status', p.status, 'createdAt', p.created_at, 'message', p.review_message,
      'award', (select jsonb_build_object('status', e.status, 'points', e.points) from point_entries e where e.user_id = auth.uid() and e.ref_type = 'path' and e.ref_id = p.id::text and e.rule = 'path_approved' limit 1))
      from paths p where p.created_by = auth.uid() order by p.created_at desc limit least(greatest(p_limit, 1), 50))
  ) t;
$$;

-- =====================================================================
-- 5. Verified trips — no location history is kept
-- =====================================================================
create table if not exists trip_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  mode text not null check (mode in ('walk','bike','scooter','drive')),
  status text not null default 'active' check (status in ('active','completed','no_award','review','rejected','abandoned','expired')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  route_m double precision not null,
  straight_m double precision not null,
  dest_lat double precision, dest_lng double precision,         -- cleared when the trip ends
  progress_m double precision not null default 0,
  checkpoints int not null default 0,
  last_lat double precision, last_lng double precision, last_at timestamptz,   -- latest check only; cleared when the trip ends
  flags text[] not null default '{}',
  eligible_m int,
  base_points int not null default 0,
  distance_points int not null default 0,
  reasons text[] not null default '{}'
);
create index if not exists trip_sessions_user on trip_sessions (user_id, started_at desc);
create index if not exists trip_sessions_review on trip_sessions (status) where status = 'review';
create table if not exists trip_routes (trip_id uuid primary key references trip_sessions(id) on delete cascade, geometry jsonb not null);
alter table trip_sessions enable row level security;
alter table trip_routes enable row level security;            -- no policies: only server functions read it
drop policy if exists "trip_sessions: read own" on trip_sessions;
create policy "trip_sessions: read own" on trip_sessions for select using (user_id = auth.uid());
grant select (id, user_id, mode, status, started_at, finished_at, route_m, eligible_m, base_points, distance_points, reasons, progress_m, checkpoints) on trip_sessions to authenticated;

create or replace function gw_trip_end(p_trip uuid, p_status text, p_reasons text[]) returns void language sql security definer set search_path = public as $$
  update trip_sessions set status = p_status, finished_at = coalesce(finished_at, now()), reasons = coalesce(p_reasons, reasons),
    last_lat = null, last_lng = null, last_at = null, dest_lat = null, dest_lng = null where id = p_trip;
  delete from trip_routes where trip_id = p_trip;
$$;
revoke execute on function gw_trip_end(uuid, text, text[]) from public, anon, authenticated;

create or replace function gw_expire_trips() returns void language plpgsql security definer set search_path = public as $$
declare t record; hrs int;
begin
  select coalesce((trip->>'maxActiveHours')::int, 6) into hrs from points_settings where id = 1;
  for t in select id from trip_sessions where status = 'active' and started_at < now() - (hrs || ' hours')::interval loop
    perform gw_trip_end(t.id, 'expired', array['The trip was not finished in time.']);
  end loop;
end $$;

create or replace function start_trip(p_mode text, p_geometry jsonb) returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t record; new_id uuid; route_m double precision; n int;
begin
  if me is null then raise exception 'Sign in to earn trip points.'; end if;
  if not (select trip_points from profiles where id = me) then raise exception 'Trip points are turned off in your settings.'; end if;
  if p_mode not in ('walk','bike','scooter','drive') then raise exception 'Unknown travel mode.'; end if;
  if p_geometry is null or jsonb_typeof(p_geometry) <> 'array' then raise exception 'No route.'; end if;
  n := jsonb_array_length(p_geometry);
  if n < 2 or n > 6000 then raise exception 'Route is missing or too long.'; end if;
  if (select count(*) from trip_sessions where user_id = me and (started_at at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date) >= 30 then
    raise exception 'Trip limit reached for today.'; end if;
  perform gw_expire_trips();
  for t in select id from trip_sessions where user_id = me and status = 'active' loop       -- one trip at a time
    perform gw_trip_end(t.id, 'abandoned', array['A new trip was started.']);
  end loop;
  route_m := gw_line_length(p_geometry);
  insert into trip_sessions (user_id, mode, route_m, straight_m, dest_lat, dest_lng)
    values (me, p_mode, route_m,
      gw_haversine((p_geometry->0->>0)::float, (p_geometry->0->>1)::float, (p_geometry->(n-1)->>0)::float, (p_geometry->(n-1)->>1)::float),
      round(((p_geometry->(n-1)->>0)::float)::numeric, 5), round(((p_geometry->(n-1)->>1)::float)::numeric, 5))
    returning id into new_id;
  insert into trip_routes (trip_id, geometry) values (new_id, p_geometry);
  return new_id;
end $$;

-- A coarse position check during navigation. Only the latest check is kept; it is used to measure progress
-- along the route and plausibility (speed), then overwritten.
create or replace function trip_checkpoint(p_trip uuid, p_lat double precision, p_lng double precision) returns void
language plpgsql security definer set search_path = public as $$
declare t trip_sessions; g jsonb; cfg jsonb; n int; i int; d double precision; best_d double precision := 1e12; best_i int := 0;
        rem double precision := 0; seg double precision; dt double precision; fl text[];
begin
  select * into t from trip_sessions where id = p_trip and user_id = auth.uid() for update;
  if t.id is null or t.status <> 'active' then return; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return; end if;
  select trip into cfg from points_settings where id = 1;
  if t.started_at < now() - ((cfg->>'maxActiveHours')::int || ' hours')::interval then perform gw_trip_end(t.id, 'expired', array['The trip was not finished in time.']); return; end if;
  if t.last_at is not null and extract(epoch from now() - t.last_at) < (cfg->>'minCheckpointGapSec')::float then return; end if;
  fl := t.flags;
  if t.last_at is not null then
    seg := gw_haversine(t.last_lat, t.last_lng, p_lat, p_lng); dt := extract(epoch from now() - t.last_at);
    if seg > 50 and dt > 0 and seg / dt > (cfg->'modes'->t.mode->>'maxSegmentSpeed')::float and not ('speed' = any(fl)) then fl := array_append(fl, 'speed'); end if;
  end if;
  select geometry into g from trip_routes where trip_id = p_trip;
  if g is not null then
    n := jsonb_array_length(g);
    for i in 0..n-1 loop
      d := gw_haversine(p_lat, p_lng, (g->i->>0)::float, (g->i->>1)::float);
      if d < best_d then best_d := d; best_i := i; end if;
    end loop;
  end if;
  if best_d < 60 then
    for i in best_i..n-2 loop rem := rem + gw_haversine((g->i->>0)::float, (g->i->>1)::float, (g->(i+1)->>0)::float, (g->(i+1)->>1)::float); end loop;
    update trip_sessions set progress_m = greatest(progress_m, least(route_m, route_m - rem)), checkpoints = checkpoints + 1 where id = p_trip;
  end if;
  update trip_sessions set last_lat = round(p_lat::numeric, 5), last_lng = round(p_lng::numeric, 5), last_at = now(), flags = fl where id = p_trip;
end $$;

-- Finish: evaluate on the server, award at most once, then delete the route and positions.
create or replace function finish_trip(p_trip uuid, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t trip_sessions; cfg jsonb; m jsonb; arrived boolean; eligible double precision; secs double precision;
        need int; reasons text[] := '{}'; base int := 0; dist int := 0; equiv double precision; b jsonb; got_base int := 0; got_dist int := 0;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  perform trip_checkpoint(p_trip, p_lat, p_lng);     -- the final position counts (subject to the same checks)
  select * into t from trip_sessions where id = p_trip and user_id = me for update;
  if t.id is null then raise exception 'Trip not found.'; end if;
  if t.status <> 'active' then                        -- idempotent: repeat calls return the stored result
    return jsonb_build_object('outcome', t.status, 'basePoints', t.base_points, 'distancePoints', t.distance_points, 'eligibleM', t.eligible_m, 'reasons', to_jsonb(t.reasons));
  end if;
  select trip into cfg from points_settings where id = 1;
  m := cfg->'modes'->t.mode;
  arrived := coalesce(p_lat is not null and gw_haversine(p_lat, p_lng, t.dest_lat, t.dest_lng) <= (cfg->>'arrivalRadiusM')::float, false)
          or coalesce(t.last_lat is not null and gw_haversine(t.last_lat, t.last_lng, t.dest_lat, t.dest_lng) <= (cfg->>'arrivalRadiusM')::float, false);
  eligible := greatest(0, least(t.progress_m, t.route_m, t.straight_m * (cfg->>'detourFactor')::float));
  secs := extract(epoch from now() - t.started_at);
  if not arrived then reasons := array_append(reasons, 'Finish within ' || (cfg->>'arrivalRadiusM') || ' m of your destination for a trip to count.'); end if;
  if t.progress_m < t.route_m * (cfg->>'minProgress')::float then reasons := array_append(reasons, 'Not enough of the route was recorded — trip points need location checks during the trip.'); end if;
  if eligible < (cfg->>'minEligibleM')::float then reasons := array_append(reasons, 'Trips under ' || (cfg->>'minEligibleM') || ' m don''t earn points.'); end if;
  need := greatest(2, ceil(eligible / 1000 * (cfg->>'checkpointsPerKm')::float)::int);
  if t.checkpoints < need then reasons := array_append(reasons, 'Too few location checks were received to verify this trip.'); end if;
  if array_length(reasons, 1) > 0 then
    update trip_sessions set eligible_m = round(eligible) where id = t.id;
    perform gw_trip_end(t.id, 'no_award', reasons);
    return jsonb_build_object('outcome', 'no_award', 'basePoints', 0, 'distancePoints', 0, 'eligibleM', round(eligible / 100) * 100, 'reasons', to_jsonb(reasons));
  end if;
  base := (m->>'basePoints')::int;
  if (m->>'distanceBonus')::boolean then
    equiv := eligible * (m->>'distanceFactor')::float;
    for b in select * from jsonb_array_elements(cfg->'bands') loop if equiv >= (b->>'minM')::float then dist := (b->>'points')::int; end if; end loop;
    dist := least(dist, (cfg->>'maxPerTrip')::int - base);
  end if;
  update trip_sessions set eligible_m = round(eligible), base_points = base, distance_points = dist where id = t.id;
  if 'speed' = any(t.flags) or secs < eligible / (m->>'maxAverageSpeed')::float then
    reasons := array['This trip looked unusually fast for the travel mode, so a moderator will check it before any points are added.'];
    perform gw_trip_end(t.id, 'review', reasons);
    return jsonb_build_object('outcome', 'review', 'basePoints', 0, 'distancePoints', 0, 'eligibleM', round(eligible / 100) * 100, 'reasons', to_jsonb(reasons));
  end if;
  got_base := gw_award(me, 'trip_completed', 'trip', t.id::text, base);
  if dist > 0 then got_dist := gw_award(me, 'trip_distance', 'trip', t.id::text, dist); end if;
  if got_base < base or got_dist < dist then reasons := array_append(reasons, 'Daily trip points limit reached — some points for this trip were capped.'); end if;
  perform gw_trip_end(t.id, 'completed', reasons);
  return jsonb_build_object('outcome', 'completed', 'basePoints', got_base, 'distancePoints', got_dist, 'eligibleM', round(eligible / 100) * 100, 'reasons', to_jsonb(reasons));
end $$;

create or replace function abandon_trip(p_trip uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from trip_sessions where id = p_trip and user_id = auth.uid() and status = 'active') then
    perform gw_trip_end(p_trip, 'abandoned', array['Navigation was ended before arrival.']);
  end if;
end $$;

-- Old clients used a self-reported check-in. It no longer awards anything; trip points come from verified trips.
create or replace function trip_check_in(p_share uuid, p_route_m double precision, p_dest_lat double precision, p_dest_lng double precision, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_share is not null then
    update shares set status = 'ended', ended_reason = 'stopped', ended_at = now() where id = p_share and from_user = auth.uid() and status <> 'ended';
  end if;
  return jsonb_build_object('basePoints', 0, 'bonusPoints', 0, 'eligibleM', 0, 'reasons', jsonb_build_array('Trip points now come from verified trips — update the app.'));
end $$;

-- =====================================================================
-- 6. Preferences & leaderboards
-- =====================================================================
create or replace function set_points_prefs(p_public boolean, p_friends boolean, p_trip_points boolean) returns void language sql security definer set search_path = public as $$
  update profiles set leaderboard_opt_in = coalesce(p_public, leaderboard_opt_in),
                      friends_board_opt_in = coalesce(p_friends, friends_board_opt_in),
                      trip_points = coalesce(p_trip_points, trip_points)
  where id = auth.uid();
$$;

-- Ranked page. scope: 'public' (opted-in users) | 'friends' (you + friends who opted in to the friends board)
-- period: 'week' (Monday 00:00 UK time → now; reversed/pending/capped excluded) | 'all' (current balance).
-- Ties share a rank (1, 2, 2, 4) and are listed alphabetically. Only alias, level and points are returned.
create or replace function leaderboard_page(p_scope text, p_period text, p_offset int default 0, p_limit int default 20)
returns table (rank bigint, alias text, level int, points bigint, is_me boolean, total bigint)
language sql stable security definer set search_path = public as $$
  with ws as (select (date_trunc('week', now() at time zone 'Europe/London') at time zone 'Europe/London') as start),
  pool as (
    select p.id, p.alias, p.points, p.level_floor from profiles p
    where p.role <> 'admin' and (
      (p_scope = 'public' and p.leaderboard_opt_in)
      or (p_scope = 'friends' and auth.uid() is not null and (p.id = auth.uid() or (p.friends_board_opt_in and gw_are_friends(auth.uid(), p.id) and not gw_blocked_either(auth.uid(), p.id))))
    )
  ),
  scored as (
    select pool.*, case when p_period = 'week'
      then coalesce((select sum(e.points) from point_entries e, ws where e.user_id = pool.id and e.status = 'awarded' and e.at >= ws.start), 0)
      else pool.points end::bigint as score
    from pool
  ),
  ranked as (
    select s.*, rank() over (order by s.score desc) as rk, count(*) over () as tot
    from scored s where s.score > 0 or p_scope = 'friends'
  )
  select rk, r.alias, greatest(gw_level_for(r.points), r.level_floor), r.score, r.id = auth.uid(), tot
  from ranked r order by rk, lower(r.alias), r.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50) offset least(greatest(coalesce(p_offset, 0), 0), 500);
$$;

-- Your own row for a board (null if you're not on it because you opted out or have no points this period).
create or replace function leaderboard_me(p_scope text, p_period text)
returns table (rank bigint, alias text, level int, points bigint, is_me boolean, total bigint)
language sql stable security definer set search_path = public as $$
  with ws as (select (date_trunc('week', now() at time zone 'Europe/London') at time zone 'Europe/London') as start),
  pool as (
    select p.id, p.alias, p.points, p.level_floor from profiles p
    where p.role <> 'admin' and (
      (p_scope = 'public' and p.leaderboard_opt_in)
      or (p_scope = 'friends' and auth.uid() is not null and (p.id = auth.uid() or (p.friends_board_opt_in and gw_are_friends(auth.uid(), p.id) and not gw_blocked_either(auth.uid(), p.id))))
    )
  ),
  scored as (
    select pool.*, case when p_period = 'week'
      then coalesce((select sum(e.points) from point_entries e, ws where e.user_id = pool.id and e.status = 'awarded' and e.at >= ws.start), 0)
      else pool.points end::bigint as score
    from pool
  ),
  ranked as (select s.*, rank() over (order by s.score desc) as rk, count(*) over () as tot from scored s where s.score > 0 or p_scope = 'friends')
  select rk, r.alias, greatest(gw_level_for(r.points), r.level_floor), r.score, true, tot from ranked r where r.id = auth.uid();
$$;

-- Old single leaderboard (kept for older clients): public all-time, top 25.
create or replace function leaderboard() returns table (alias text, points int, is_me boolean) language sql stable security definer set search_path = public as $$
  select alias, points, id = auth.uid() from profiles where leaderboard_opt_in and role <> 'admin' order by points desc, lower(alias) limit 25;
$$;

-- =====================================================================
-- 7. Moderator tools (admins only, every action logged)
-- =====================================================================
create or replace function admin_user_points(p_alias text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into u from profiles where lower(alias) = lower(trim(p_alias));
  if u.id is null then return null; end if;
  return jsonb_build_object('id', u.id, 'alias', u.alias, 'points', u.points, 'levelFloor', u.level_floor,
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'rule', e.rule, 'points', e.points, 'status', e.status, 'refType', e.ref_type, 'refId', e.ref_id,
                    'at', e.at, 'reason', e.reason, 'reversalOf', e.reversal_of) order by e.at desc) from (select * from point_entries where user_id = u.id order by at desc limit 100) e), '[]'::jsonb));
end $$;

create or replace function admin_reverse_award(p_entry uuid, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare e point_entries; n int;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason (at least 5 characters).'; end if;
  select * into e from point_entries where id = p_entry;
  if e.id is null then raise exception 'Award not found.'; end if;
  n := gw_reverse_entry(p_entry, p_reason, auth.uid());
  insert into admin_actions (admin_id, action, target_user, target_ref, reason) values (auth.uid(), 'reverse_award', e.user_id, 'point_entry:' || p_entry, left(p_reason, 300));
  return n;
end $$;

-- Reverse every award tied to a contribution later found to be fraudulent, and take it off the map.
create or replace function admin_reverse_source(p_ref_type text, p_ref_id text, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare e record; total int := 0;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason (at least 5 characters).'; end if;
  for e in select id from point_entries where ref_type = p_ref_type and ref_id = p_ref_id and status in ('awarded','capped') and rule <> 'reversal' loop
    total := total + gw_reverse_entry(e.id, p_reason, auth.uid());
  end loop;
  if p_ref_type = 'path' then update paths set status = 'rejected', review_message = left(p_reason, 300), reviewed_at = now() where id::text = p_ref_id; end if;
  if p_ref_type = 'alert' then update alerts set status = 'rejected', reviewed_at = now() where id::text = p_ref_id; end if;
  insert into admin_actions (admin_id, action, target_ref, reason) values (auth.uid(), 'reverse_source', p_ref_type || ':' || p_ref_id, left(p_reason, 300));
  return total;
end $$;

create or replace function admin_trips_for_review() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'alias', p.alias, 'mode', t.mode, 'eligibleM', t.eligible_m, 'routeM', round(t.route_m),
    'minutes', round(extract(epoch from t.finished_at - t.started_at) / 60), 'checkpoints', t.checkpoints, 'flags', t.flags,
    'basePoints', t.base_points, 'distancePoints', t.distance_points, 'day', to_char(t.started_at at time zone 'Europe/London', 'YYYY-MM-DD')) order by t.finished_at)
    from trip_sessions t join profiles p on p.id = t.user_id where t.status = 'review'), '[]'::jsonb);
end $$;

create or replace function admin_review_trip(p_trip uuid, p_decision text, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare t trip_sessions; got int := 0;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into t from trip_sessions where id = p_trip for update;
  if t.id is null or t.status <> 'review' then raise exception 'This trip is not awaiting review.'; end if;
  if p_decision = 'approve' then
    got := gw_award(t.user_id, 'trip_completed', 'trip', t.id::text, t.base_points);
    if t.distance_points > 0 then got := got + gw_award(t.user_id, 'trip_distance', 'trip', t.id::text, t.distance_points); end if;
    update trip_sessions set status = 'completed', reasons = array['Checked and approved by a moderator.'] where id = t.id;
  else
    update trip_sessions set status = 'rejected', reasons = array['A moderator could not verify this trip' || coalesce(': ' || nullif(left(p_reason, 200), ''), '.')] where id = t.id;
  end if;
  insert into admin_actions (admin_id, action, target_user, target_ref, reason) values (auth.uid(), 'trip_' || p_decision, t.user_id, 'trip:' || p_trip, left(p_reason, 300));
  return got;
end $$;

-- Expire unfinished trips every 10 minutes when pg_cron is available (they also expire on the next trip start).
do $$ begin
  perform cron.schedule('gw-expire-trips', '*/10 * * * *', 'select gw_expire_trips()');
exception when others then raise notice 'pg_cron not available; trips expire on the next start instead.'; end $$;
