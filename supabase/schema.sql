-- GettoWayz — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Everything security-relevant lives here: row-level security, rate limits, points, sharing access, trip rewards.
-- The browser only ever uses the anon key + the signed-in user's JWT; RLS and SECURITY DEFINER functions do the rest.

create extension if not exists pgcrypto;

-- =====================================================================
-- Helpers
-- =====================================================================
create or replace function gw_haversine(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- Non-sequential public ID like GW-7K3Q-M9PX (no 0/O/1/I/L)
create or replace function gw_make_id() returns text language plpgsql as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; res text := ''; i int;
begin
  for i in 1..8 loop res := res || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
  return 'GW-' || substr(res, 1, 4) || '-' || substr(res, 5, 4);
end $$;

-- =====================================================================
-- Profiles (one per auth user). Email lives only in auth.users and is never exposed.
-- =====================================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  alias text not null unique check (alias ~ '^[A-Za-z0-9_.-]{3,20}$'),
  gw_id text not null unique default gw_make_id(),
  role text not null default 'user' check (role in ('user','admin')),
  points int not null default 0,
  leaderboard_opt_in boolean not null default false,
  request_setting text not null default 'anyone' check (request_setting in ('anyone','none')),
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
create policy "profiles: read own" on profiles for select using (auth.uid() = id);
-- No direct updates from clients: preferences change through set_my_prefs(), points only through gw_grant().

-- Create the profile automatically on sign-up (alias passed as user metadata)
create or replace function gw_handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, alias) values (new.id, coalesce(new.raw_user_meta_data->>'alias', 'user_' || left(new.id::text, 6)));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function gw_handle_new_user();

-- Minimal public view other users may see (alias + id only)
create or replace view public_profiles with (security_invoker = false) as select id, alias, gw_id from profiles;
grant select on public_profiles to authenticated;

create or replace function gw_is_admin() returns boolean language sql stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- =====================================================================
-- Points ledger — only written by SECURITY DEFINER functions, never by clients
-- =====================================================================
create table if not exists point_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  rule text not null, points int not null, ref_type text, ref_id text,
  at timestamptz not null default now(),
  unique (user_id, rule, ref_id)                 -- never double-grant
);
alter table point_entries enable row level security;
create policy "points: read own" on point_entries for select using (auth.uid() = user_id);

create or replace function gw_grant(p_user uuid, p_rule text, p_ref_type text, p_ref_id text, p_points int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into point_entries (user_id, rule, points, ref_type, ref_id) values (p_user, p_rule, p_points, p_ref_type, p_ref_id)
  on conflict do nothing;
  if found then update profiles set points = points + p_points where id = p_user; end if;
end $$;

-- =====================================================================
-- Community alerts
-- =====================================================================
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
    category text not null check (category in ('blocked','pothole','lighting','closure','flooding','other','light_out','light_ok')),
  lat double precision not null, lng double precision not null,
  note text not null default '' check (length(note) <= 240),
  status text not null default 'pending' check (status in ('pending','verified','rejected','resolved')),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reviewed_at timestamptz
);
create table if not exists alert_confirmations (
  alert_id uuid references alerts(id) on delete cascade, user_id uuid references profiles(id) on delete cascade,
  at timestamptz default now(), primary key (alert_id, user_id)
);
alter table alerts enable row level security; alter table alert_confirmations enable row level security;
create policy "alerts: anyone reads active" on alerts for select using (status in ('pending','verified') and expires_at > now() or gw_is_admin());
create policy "confirmations: read" on alert_confirmations for select using (true);

create or replace function create_alert(p_category text, p_lat double precision, p_lng double precision, p_note text)
returns alerts language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); days int; a alerts;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  if (select count(*) from alerts where created_by = me and created_at::date = current_date) >= 5 then raise exception 'Limit reached: 5 reports per day.'; end if;
    if exists (select 1 from alerts where created_by = me and status = 'pending' and category = p_category and gw_haversine(lat, lng, p_lat, p_lng) < 25) then raise exception 'You already have a pending report at this spot.'; end if;
    days := case p_category when 'blocked' then 7 when 'pothole' then 30 when 'lighting' then 60 when 'closure' then 14 when 'flooding' then 3 when 'light_out' then 30 when 'light_ok' then 14 else 14 end;
  insert into alerts (category, lat, lng, note, created_by, expires_at)
    values (p_category, round(p_lat::numeric, 5), round(p_lng::numeric, 5), left(coalesce(p_note, ''), 240), me, now() + (days || ' days')::interval)
    returning * into a;
  return a;
end $$;

create or replace function confirm_alert(p_alert uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); owner uuid; n int;
begin
  select created_by into owner from alerts where id = p_alert;
  if owner is null then raise exception 'Alert not found.'; end if;
  if owner = me then raise exception 'You can''t confirm your own report.'; end if;
  if (select count(*) from alert_confirmations where user_id = me and at::date = current_date) >= 20 then raise exception 'Confirmation limit reached for today.'; end if;
  insert into alert_confirmations (alert_id, user_id) values (p_alert, me) on conflict do nothing;
  if not found then raise exception 'Already confirmed.'; end if;
  select count(*) into n from alert_confirmations where alert_id = p_alert;
  if n = 2 then perform gw_grant(owner, 'alert_confirmed', 'alert', p_alert::text, 5); end if;
end $$;

create or replace function review_alert(p_alert uuid, p_decision text) returns void language plpgsql security definer set search_path = public as $$
declare a alerts; c record;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into a from alerts where id = p_alert;
  if p_decision = 'verify' and a.status <> 'verified' then
    update alerts set status = 'verified', reviewed_at = now() where id = p_alert;
    perform gw_grant(a.created_by, 'alert_verified', 'alert', p_alert::text, 10);
    for c in select user_id from alert_confirmations where alert_id = p_alert loop perform gw_grant(c.user_id, 'confirm_helpful', 'alert', p_alert::text, 2); end loop;
  elsif p_decision = 'reject' then update alerts set status = 'rejected' where id = p_alert;
  elsif p_decision = 'resolve' then update alerts set status = 'resolved' where id = p_alert;
  end if;
end $$;

-- =====================================================================
-- Community paths
-- =====================================================================
create table if not exists paths (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 3 and 60),
  type text not null check (type in ('footpath','cycle','shared','steps')),
  surface text not null default 'unknown',
  note text not null default '' check (length(note) <= 300),
  points jsonb not null,                        -- [[lat,lng], ...]
  status text not null default 'pending' check (status in ('pending','approved','rejected','changes')),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz, review_message text
);
alter table paths enable row level security;
create policy "paths: approved public, own always, admin all" on paths for select using (status = 'approved' or created_by = auth.uid() or gw_is_admin());

create or replace function suggest_path(p_name text, p_type text, p_surface text, p_note text, p_points jsonb)
returns paths language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); p paths; len double precision := 0; i int;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  if jsonb_array_length(p_points) < 2 then raise exception 'Draw at least two points.'; end if;
  for i in 1..jsonb_array_length(p_points) - 1 loop
    len := len + gw_haversine((p_points->(i-1)->>0)::float, (p_points->(i-1)->>1)::float, (p_points->i->>0)::float, (p_points->i->>1)::float);
  end loop;
  if len < 10 then raise exception 'That path is too short to review.'; end if;
  if len > 3000 then raise exception 'Keep suggestions under 3 km — split long paths.'; end if;
  if (select count(*) from paths where created_by = me and created_at::date = current_date) >= 3 then raise exception 'Limit reached: 3 path suggestions per day.'; end if;
  insert into paths (name, type, surface, note, points, created_by) values (left(p_name, 60), p_type, p_surface, left(coalesce(p_note, ''), 300), p_points, me) returning * into p;
  return p;
end $$;

create or replace function review_path(p_path uuid, p_decision text, p_message text) returns void language plpgsql security definer set search_path = public as $$
declare p paths;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into p from paths where id = p_path;
  if p_decision = 'approve' then
    update paths set status = 'approved', reviewed_at = now(), review_message = left(coalesce(p_message, ''), 300) where id = p_path;
    perform gw_grant(p.created_by, 'path_approved', 'path', p_path::text, 50);
  else
    update paths set status = case p_decision when 'reject' then 'rejected' else 'changes' end, reviewed_at = now(), review_message = left(coalesce(p_message, ''), 300) where id = p_path;
  end if;
end $$;

-- =====================================================================
-- Friends, blocks, reports
-- =====================================================================
create table if not exists friends (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(), responded_at timestamptz,
  check (from_user <> to_user)
);
create unique index if not exists friends_pair on friends (least(from_user, to_user), greatest(from_user, to_user));
create table if not exists blocks (by_user uuid references profiles(id) on delete cascade, target uuid references profiles(id) on delete cascade, at timestamptz default now(), primary key (by_user, target));
create table if not exists reports (id uuid primary key default gen_random_uuid(), by_user uuid references profiles(id), target uuid references profiles(id), reason text, at timestamptz default now());
create table if not exists id_lookups (by_user uuid references profiles(id) on delete cascade, at timestamptz default now());
alter table friends enable row level security; alter table blocks enable row level security; alter table reports enable row level security; alter table id_lookups enable row level security;
create policy "friends: participants read" on friends for select using (auth.uid() in (from_user, to_user));
create policy "blocks: own" on blocks for all using (by_user = auth.uid()) with check (by_user = auth.uid());
create policy "reports: admin reads" on reports for select using (gw_is_admin());
create policy "reports: insert own" on reports for insert with check (by_user = auth.uid());

create or replace function gw_blocked_either(a uuid, b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from blocks where (by_user = a and target = b) or (by_user = b and target = a));
$$;
create or replace function gw_are_friends(a uuid, b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from friends where status = 'accepted' and least(from_user, to_user) = least(a, b) and greatest(from_user, to_user) = greatest(a, b));
$$;

-- ID lookup: rate limited, returns alias + id only, blocked users look like they don't exist
create or replace function lookup_id(p_id text) returns table (id uuid, alias text, gw_id text) language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); norm text;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  delete from id_lookups where at < now() - interval '1 hour';
  if (select count(*) from id_lookups l where l.by_user = me) >= 10 then raise exception 'Too many ID searches — try again in an hour.'; end if;
  insert into id_lookups (by_user) values (me);
  norm := regexp_replace(upper(p_id), '[^A-Z0-9]', '', 'g'); norm := regexp_replace(norm, '^GW', '');
  norm := 'GW-' || substr(norm, 1, 4) || '-' || substr(norm, 5, 4);
  return query select p.id, p.alias, p.gw_id from profiles p where p.gw_id = norm and p.id <> me and p.role <> 'admin' and not gw_blocked_either(me, p.id);
end $$;

create or replace function send_friend_request(p_target uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); t profiles;
begin
  select * into t from profiles where id = p_target;
  if t.id is null or t.id = me or gw_blocked_either(me, t.id) then raise exception 'Could not find that user.'; end if;
  if t.request_setting = 'none' then raise exception 'This user is not accepting friend requests.'; end if;
  if gw_are_friends(me, t.id) then raise exception 'You are already friends.'; end if;
  if exists (select 1 from friends where status = 'pending' and from_user = t.id and to_user = me) then raise exception 'They already sent you a request — accept it from your inbox.'; end if;
  if (select count(*) from friends where from_user = me and created_at::date = current_date) >= 10 then raise exception 'Limit reached: 10 friend requests per day.'; end if;
  if (select count(*) from friends where status = 'accepted' and me in (from_user, to_user)) >= 50 then raise exception 'Friend list is full.'; end if;
  insert into friends (from_user, to_user) values (me, t.id) on conflict do nothing;
  if not found then raise exception 'Request already sent.'; end if;
end $$;

create or replace function respond_friend_request(p_request uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_accept then update friends set status = 'accepted', responded_at = now() where id = p_request and to_user = auth.uid() and status = 'pending';
  else delete from friends where id = p_request and to_user = auth.uid() and status = 'pending'; end if;
  if not found then raise exception 'Request not found.'; end if;
end $$;
create or replace function cancel_friend_request(p_request uuid) returns void language sql security definer set search_path = public as $$
  delete from friends where id = p_request and from_user = auth.uid() and status = 'pending';
$$;

create or replace function remove_friend(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from friends where least(from_user, to_user) = least(auth.uid(), p_user) and greatest(from_user, to_user) = greatest(auth.uid(), p_user);
  perform gw_end_shares_between(auth.uid(), p_user, 'unfriended');
end $$;
create or replace function block_user(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into blocks (by_user, target) values (auth.uid(), p_user) on conflict do nothing;
  perform gw_end_shares_between(auth.uid(), p_user, 'blocked');   -- ends sharing in BOTH directions immediately
  delete from friends where least(from_user, to_user) = least(auth.uid(), p_user) and greatest(from_user, to_user) = greatest(auth.uid(), p_user);
end $$;

-- =====================================================================
-- Sharing sessions — only the latest position is stored; deleted when the session ends
-- =====================================================================
create table if not exists shares (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade,
  type text not null check (type in ('location','trip')),
  status text not null default 'active' check (status in ('active','paused','ended')),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz, ended_reason text,
  last_lat double precision, last_lng double precision, last_at timestamptz,
  trip jsonb            -- { destName, destLat, destLng, geometry, routeDistanceM, durationS, progressM, arrived, rewardOptIn: {uid: true}, bonusPoints }
);
alter table shares enable row level security;
-- Participants read. The position columns are part of the row, and only the two participants ever match this policy.
create policy "shares: participants read" on shares for select using (auth.uid() in (from_user, to_user));
alter publication supabase_realtime add table shares;

create or replace function gw_expire_shares() returns void language sql security definer set search_path = public as $$
  update shares set status = 'ended', ended_reason = 'expired', ended_at = now(), last_lat = null, last_lng = null, last_at = null, trip = trip - 'geometry'
  where status <> 'ended' and ends_at <= now();
$$;

create or replace function gw_end_shares_between(a uuid, b uuid, reason text) returns void language sql security definer set search_path = public as $$
  update shares set status = 'ended', ended_reason = reason, ended_at = now(), last_lat = null, last_lng = null, last_at = null, trip = trip - 'geometry'
  where status <> 'ended' and ((from_user = a and to_user = b) or (from_user = b and to_user = a));
$$;
create or replace function start_share(p_to uuid, p_minutes int, p_type text, p_trip jsonb) returns shares language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s shares; m int;
begin
  perform gw_expire_shares();
  if me is null then raise exception 'Sign in to do this.'; end if;
  if not gw_are_friends(me, p_to) then raise exception 'You can only share with an accepted friend.'; end if;
  if gw_blocked_either(me, p_to) then raise exception 'Sharing is not available with this user.'; end if;
  m := least(240, greatest(5, p_minutes));
  if p_type = 'location' and m not in (15, 30, 60, 120) then raise exception 'Pick one of the offered durations.'; end if;
  update shares set status = 'ended', ended_reason = 'replaced', ended_at = now(), last_lat = null, last_lng = null, last_at = null, trip = trip - 'geometry'
    where status <> 'ended' and from_user = me and to_user = p_to and type = p_type;
  insert into shares (from_user, to_user, type, ends_at, trip) values (me, p_to, p_type, now() + (m || ' minutes')::interval, p_trip) returning * into s;
  return s;
end $$;

create or replace function set_share_status(p_share uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status = 'ended' then
    update shares set status = 'ended', ended_reason = coalesce(p_reason, 'stopped'), ended_at = now(), last_lat = null, last_lng = null, last_at = null, trip = trip - 'geometry'
      where id = p_share and from_user = auth.uid() and status <> 'ended';
  elsif p_status = 'paused' then update shares set status = 'paused', last_lat = null, last_lng = null, last_at = null where id = p_share and from_user = auth.uid() and status = 'active';
  elsif p_status = 'active' then update shares set status = 'active' where id = p_share and from_user = auth.uid() and status = 'paused' and ends_at > now();
  end if;
  if not found then raise exception 'Not your sharing session.'; end if;
end $$;

-- Owner pushes a position. Progress along the route is computed HERE so clients cannot inflate it.
create or replace function update_share_position(p_share uuid, p_lat double precision, p_lng double precision) returns void language plpgsql security definer set search_path = public as $$
declare s shares; g jsonb; n int; i int; d double precision; best_d double precision := 1e12; best_i int := 0; rem double precision := 0; route_m double precision; prog double precision;
begin
  perform gw_expire_shares();
  select * into s from shares where id = p_share;
  if s.id is null or s.from_user <> auth.uid() then raise exception 'Not your sharing session.'; end if;
  if s.status <> 'active' then return; end if;
  update shares set last_lat = round(p_lat::numeric, 5), last_lng = round(p_lng::numeric, 5), last_at = now() where id = p_share;
  g := s.trip->'geometry';
  if g is not null then
    n := jsonb_array_length(g);
    for i in 0..n-1 loop
      d := gw_haversine(p_lat, p_lng, (g->i->>0)::float, (g->i->>1)::float);
      if d < best_d then best_d := d; best_i := i; end if;
    end loop;
    if best_d < 60 then  -- off-route positions earn nothing
      for i in best_i..n-2 loop rem := rem + gw_haversine((g->i->>0)::float, (g->i->>1)::float, (g->(i+1)->>0)::float, (g->(i+1)->>1)::float); end loop;
      route_m := (s.trip->>'routeDistanceM')::float;
      prog := greatest(coalesce((s.trip->>'progressM')::float, 0), least(route_m, route_m - rem));  -- monotonic, capped
      update shares set trip = jsonb_set(trip, '{progressM}', to_jsonb(prog)) where id = p_share;
    end if;
  end if;
end $$;

create or replace function opt_in_trip_reward(p_share uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  update shares set trip = jsonb_set(trip, array['rewardOptIn', me::text], 'true'::jsonb, true)
    where id = p_share and type = 'trip' and status <> 'ended' and me in (from_user, to_user);
  if not found then raise exception 'Session not found.'; end if;
end $$;

-- =====================================================================
-- Trip completion & shared-trip bonus (verified, replay-safe, capped)
-- =====================================================================
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  share_id uuid unique references shares(id),   -- unique → a share can only be checked in once
  distance_m int not null, bonus_m int not null default 0, bonus_points int not null default 0,
  at timestamptz not null default now()
);
alter table trips enable row level security;
create policy "trips: read own" on trips for select using (user_id = auth.uid());

create or replace function gw_bonus_for(m double precision) returns int language sql immutable as $$
  select least(20, case when m >= 6000 then 20 when m >= 3000 then 12 when m >= 1500 then 8 when m >= 500 then 4 else 0 end);
$$;

create or replace function trip_check_in(p_share uuid, p_route_m double precision, p_dest_lat double precision, p_dest_lng double precision, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s shares; base int := 0; bonus int := 0; bonus_m double precision := 0; spent int; todays int; reasons text[] := '{}'; opt jsonb; tid uuid;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  perform gw_expire_shares();
  if p_share is not null then
    select * into s from shares where id = p_share and from_user = me;
    if s.id is null then raise exception 'Trip session not found.'; end if;
    if exists (select 1 from trips where share_id = p_share) then raise exception 'This trip was already checked in.'; end if;
  end if;
  if p_lat is not null and gw_haversine(p_lat, p_lng, p_dest_lat, p_dest_lng) > 75 then
    reasons := array_append(reasons, 'You are not at the destination yet, so no points were awarded.');
  else
    select count(*) into todays from trips where user_id = me and at::date = current_date;
    if p_route_m < 200 then reasons := array_append(reasons, 'Trips under 200 m do not earn points.');
    elsif todays >= 8 then reasons := array_append(reasons, 'Daily check-in limit reached.');
    else
      tid := gen_random_uuid();
      perform gw_grant(me, 'trip_completed', 'trip', tid::text, 5); base := 5;
      if s.id is not null and s.trip is not null then
        opt := coalesce(s.trip->'rewardOptIn', '{}'::jsonb);
        if (opt->>s.from_user::text) = 'true' and (opt->>s.to_user::text) = 'true' then
          bonus_m := case when coalesce((s.trip->>'progressM')::float, 0) > 0 then least((s.trip->>'progressM')::float, p_route_m) else p_route_m end;
          select coalesce(sum(bonus_points), 0) into spent from trips where user_id = me and at::date = current_date;
          bonus := greatest(0, least(gw_bonus_for(bonus_m), 40 - spent));
          if bonus > 0 then
            perform gw_grant(me, 'shared_trip_bonus', 'trip', tid::text, bonus);
            perform gw_grant(s.to_user, 'shared_trip_bonus', 'share', s.id::text, bonus);
          elsif spent >= 40 then reasons := array_append(reasons, 'Daily shared-trip bonus cap reached.'); end if;
        else reasons := array_append(reasons, 'No shared-trip bonus: both of you need to opt in before arrival.'); end if;
      end if;
      insert into trips (id, user_id, share_id, distance_m, bonus_m, bonus_points) values (tid, me, s.id, round(p_route_m), round(bonus_m), bonus);
    end if;
  end if;
  if s.id is not null then
    update shares set status = 'ended', ended_reason = 'arrived', ended_at = now(), last_lat = null, last_lng = null, last_at = null,
      trip = (trip - 'geometry') || jsonb_build_object('arrived', true, 'bonusPoints', bonus) where id = s.id;
  end if;
  return jsonb_build_object('basePoints', base, 'bonusPoints', bonus, 'eligibleM', round(bonus_m), 'reasons', to_jsonb(reasons));
end $$;

-- =====================================================================
-- Table privileges (RLS above decides which ROWS; these decide which OPERATIONS clients may attempt)
-- =====================================================================
grant usage on schema public to authenticated, anon;
grant select on profiles, point_entries, alerts, alert_confirmations, paths, friends, shares, trips to authenticated;
grant select, insert, delete on blocks to authenticated;
grant select, insert on reports to authenticated;
grant select on alerts, alert_confirmations, paths to anon;        -- guests can browse alerts and approved paths
grant usage on all sequences in schema public to authenticated;

-- =====================================================================
-- Leaderboard (opt-in only) and admin helpers
-- =====================================================================
create or replace function leaderboard() returns table (alias text, points int, is_me boolean) language sql stable security definer set search_path = public as $$
  select alias, points, id = auth.uid() from profiles where leaderboard_opt_in and role <> 'admin' order by points desc limit 25;
$$;
create or replace function alias_of(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select alias from profiles where id = p_user;
$$;
create or replace function set_my_prefs(p_opt_in boolean, p_request_setting text) returns void language sql security definer set search_path = public as $$
  update profiles set leaderboard_opt_in = coalesce(p_opt_in, leaderboard_opt_in), request_setting = coalesce(p_request_setting, request_setting) where id = auth.uid();
$$;

-- Expire sessions every minute even if nobody is online (requires the pg_cron extension: Database → Extensions → enable pg_cron)
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('gw-expire-shares', '* * * * *', 'select gw_expire_shares()');
exception when others then
  raise notice 'pg_cron not available (%). Enable it under Database → Extensions and re-run the two lines above. Sessions still expire on the next read.', sqlerrm;
end $$;

-- =====================================================================
-- Make yourself a moderator (run after you have signed up in the app):
--   update profiles set role = 'admin' where alias = 'your-alias';
-- =====================================================================
