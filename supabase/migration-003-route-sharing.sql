-- Migration 003 — friend route sharing: invitations, per-trip live progress, private route geometry.
-- Run once in the Supabase SQL editor (safe to re-run). Requires schema.sql (and migration 002) to have been run first.
--
-- Model for trip shares:
--   invited  → the friend sees an invitation: who, where to, travel mode, distance, time. No route line, no position.
--   active   → the friend accepted. They can see the route line, and — only while `live` is on — your latest position.
--   ended    → stopped, arrived, declined, expired, unfriended or blocked. Route line and position are deleted.
-- `live` is the traveller's per-trip switch for sending their position. Positions are never stored for an
-- invitation that hasn't been accepted, or while live is off.

alter table shares drop constraint if exists shares_status_check;
alter table shares add constraint shares_status_check check (status in ('invited','active','paused','ended'));
alter table shares add column if not exists live boolean not null default true;   -- location shares are always live
alter table shares add column if not exists responded_at timestamptz;

-- Route geometry lives in its own table so it can be hidden from an invitation that hasn't been accepted.
create table if not exists share_routes (
  share_id uuid primary key references shares(id) on delete cascade,
  geometry jsonb not null
);
alter table share_routes enable row level security;
drop policy if exists "share_routes: owner or accepted recipient" on share_routes;
create policy "share_routes: owner or accepted recipient" on share_routes for select using (
  exists (select 1 from shares s where s.id = share_id and s.status <> 'ended'
          and (s.from_user = auth.uid() or (s.to_user = auth.uid() and s.status = 'active'))));
grant select on share_routes to authenticated;

-- Whenever a share stops being active+live, its position is wiped; when it ends, its route is deleted too.
create or replace function gw_share_cleanup() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ended' then
    delete from share_routes where share_id = new.id;
    new.trip := case when new.trip is null then null else new.trip - 'geometry' end;
  end if;
  if new.status <> 'active' or not new.live then
    new.last_lat := null; new.last_lng := null; new.last_at := null;
  end if;
  return new;
end $$;
drop trigger if exists gw_share_cleanup on shares;
create trigger gw_share_cleanup before update on shares for each row execute function gw_share_cleanup();

create or replace function gw_line_length(g jsonb) returns double precision language plpgsql immutable as $$
declare n int := jsonb_array_length(g); i int; t double precision := 0;
begin
  for i in 0..n-2 loop t := t + gw_haversine((g->i->>0)::float, (g->i->>1)::float, (g->(i+1)->>0)::float, (g->(i+1)->>1)::float); end loop;
  return t;
end $$;

-- Traveller shares a planned or active route with ONE accepted friend. Starts as an invitation.
create or replace function start_trip_share(p_to uuid, p_trip jsonb, p_geometry jsonb, p_live boolean) returns shares
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s shares; m int; dur double precision; route_m double precision; mode text;
begin
  perform gw_expire_shares();
  if me is null then raise exception 'Sign in to do this.'; end if;
  if p_to = me then raise exception 'Choose a friend to share with.'; end if;
  if not gw_are_friends(me, p_to) then raise exception 'You can only share a route with an accepted friend.'; end if;
  if gw_blocked_either(me, p_to) then raise exception 'Sharing is not available with this user.'; end if;
  if p_geometry is null or jsonb_typeof(p_geometry) <> 'array' or jsonb_array_length(p_geometry) < 2 then raise exception 'No route to share.'; end if;
  if jsonb_array_length(p_geometry) > 6000 then raise exception 'This route is too long to share.'; end if;
  if (select count(*) from shares where from_user = me and type = 'trip' and started_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many route shares in the last hour — try again later.'; end if;
  route_m := gw_line_length(p_geometry);                       -- distance is measured here, not trusted from the client
  dur := greatest(60, least(6 * 3600, coalesce((p_trip->>'durationS')::float, route_m / 1.35)));
  m := least(240, ceil(dur / 60 * 2)::int + 15);
  mode := case when p_trip->>'mode' in ('walk','bike','scooter','drive') then p_trip->>'mode' else 'walk' end;
  update shares set status = 'ended', ended_reason = 'replaced', ended_at = now()
    where status <> 'ended' and from_user = me and to_user = p_to and type = 'trip';
  insert into shares (from_user, to_user, type, status, live, ends_at, trip) values (me, p_to, 'trip', 'invited', coalesce(p_live, false),
    now() + (m || ' minutes')::interval,
    jsonb_build_object(
      'destName', left(coalesce(p_trip->>'destName', 'Destination'), 80),
      'destLat', round((p_geometry->-1->>0)::numeric, 5), 'destLng', round((p_geometry->-1->>1)::numeric, 5),
      'mode', mode, 'routeDistanceM', round(route_m), 'durationS', round(dur), 'progressM', 0, 'arrived', false,
      'toFriendLocation', coalesce((p_trip->>'toFriendLocation')::boolean, false),
      'rewardOptIn', case when coalesce((p_trip->>'rewardOptIn')::boolean, false) then jsonb_build_object(me::text, true) else '{}'::jsonb end))
    returning * into s;
  insert into share_routes (share_id, geometry) values (s.id, p_geometry);
  return s;
end $$;

-- Recipient accepts or declines an invitation.
create or replace function respond_trip_share(p_share uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare s shares;
begin
  perform gw_expire_shares();
  select * into s from shares where id = p_share and to_user = auth.uid() and type = 'trip';
  if s.id is null then raise exception 'Invitation not found.'; end if;
  if s.status <> 'invited' then raise exception 'This invitation is no longer open (%).', coalesce(s.ended_reason, s.status); end if;
  if not gw_are_friends(s.from_user, s.to_user) then
    update shares set status = 'ended', ended_reason = 'unfriended', ended_at = now() where id = p_share;
    raise exception 'You are no longer friends, so this invitation has ended.';
  end if;
  if p_accept then
    update shares set status = 'active', responded_at = now(), trip = trip || jsonb_build_object('acceptedAt', now()) where id = p_share;
  else
    update shares set status = 'ended', ended_reason = 'declined', ended_at = now(), responded_at = now() where id = p_share;
  end if;
end $$;

-- Traveller turns live progress on/off for this trip. Turning it on gives the session enough time for the trip.
create or replace function set_trip_live(p_share uuid, p_live boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  perform gw_expire_shares();
  update shares set live = p_live,
    ends_at = case when p_live then greatest(ends_at, now() + (least(240, ceil(coalesce((trip->>'durationS')::float, 1800) / 60 * 2)::int + 15) || ' minutes')::interval) else ends_at end
    where id = p_share and from_user = auth.uid() and type = 'trip' and status in ('invited','active');
  if not found then raise exception 'This route share has ended.'; end if;
end $$;

-- Stop/leave. The traveller can stop at any time; the recipient can stop following. "arrived" is only
-- recorded when the traveller's latest position is actually at the destination.
create or replace function set_share_status(p_share uuid, p_status text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare s shares; r text;
begin
  select * into s from shares where id = p_share;
  if s.id is null or auth.uid() not in (s.from_user, s.to_user) then raise exception 'Not your sharing session.'; end if;
  if p_status = 'ended' then
    if s.status = 'ended' then return; end if;
    if auth.uid() = s.to_user then r := 'left';
    else
      r := case when p_reason in ('stopped','cancelled','arrived') then p_reason else 'stopped' end;
      if r = 'arrived' and not (s.last_lat is not null and s.trip is not null
          and gw_haversine(s.last_lat, s.last_lng, (s.trip->>'destLat')::float, (s.trip->>'destLng')::float) <= 75) then r := 'stopped'; end if;
    end if;
    update shares set status = 'ended', ended_reason = r, ended_at = now() where id = p_share;
  elsif auth.uid() <> s.from_user then raise exception 'Not your sharing session.';
  elsif p_status = 'paused' then update shares set status = 'paused' where id = p_share and status = 'active' and type = 'location';
  elsif p_status = 'active' then update shares set status = 'active' where id = p_share and status = 'paused' and ends_at > now();
  end if;
end $$;

-- Owner pushes a position: stored only for an accepted share with live on. Progress is computed here.
create or replace function update_share_position(p_share uuid, p_lat double precision, p_lng double precision) returns void language plpgsql security definer set search_path = public as $$
declare s shares; g jsonb; n int; i int; d double precision; best_d double precision := 1e12; best_i int := 0; rem double precision := 0; route_m double precision; prog double precision;
begin
  perform gw_expire_shares();
  select * into s from shares where id = p_share;
  if s.id is null or s.from_user <> auth.uid() then raise exception 'Not your sharing session.'; end if;
  if s.status <> 'active' or not s.live then return; end if;
  update shares set last_lat = round(p_lat::numeric, 5), last_lng = round(p_lng::numeric, 5), last_at = now() where id = p_share;
  if s.type <> 'trip' then return; end if;
  select geometry into g from share_routes where share_id = p_share;
  if g is null then g := s.trip->'geometry'; end if;   -- sessions created before migration 003
  if g is null then return; end if;
  n := jsonb_array_length(g);
  for i in 0..n-1 loop
    d := gw_haversine(p_lat, p_lng, (g->i->>0)::float, (g->i->>1)::float);
    if d < best_d then best_d := d; best_i := i; end if;
  end loop;
  if best_d < 60 then  -- off-route positions earn nothing
    for i in best_i..n-2 loop rem := rem + gw_haversine((g->i->>0)::float, (g->i->>1)::float, (g->(i+1)->>0)::float, (g->(i+1)->>1)::float); end loop;
    route_m := (s.trip->>'routeDistanceM')::float;
    prog := greatest(coalesce((s.trip->>'progressM')::float, 0), least(route_m, route_m - rem));  -- monotonic, capped
    update shares set trip = jsonb_set(trip, '{progressM}', to_jsonb(round(prog))) where id = p_share;
  end if;
end $$;

-- Reward opt-in: the recipient can only opt in after accepting.
create or replace function opt_in_trip_reward(p_share uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  update shares set trip = jsonb_set(trip, array['rewardOptIn', me::text], 'true'::jsonb, true)
    where id = p_share and type = 'trip' and (me = from_user and status in ('invited','active') or me = to_user and status = 'active');
  if not found then raise exception 'Accept the invitation first.'; end if;
end $$;

-- Check-in: unchanged rules, except the shared-trip bonus also requires the friend to have accepted the invitation.
-- Sharing itself never earns points.
create or replace function trip_check_in(p_share uuid, p_route_m double precision, p_dest_lat double precision, p_dest_lng double precision, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s shares; base int := 0; bonus int := 0; bonus_m double precision := 0; spent int; todays int; reasons text[] := '{}'; opt jsonb; tid uuid; route_m double precision := p_route_m;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  perform gw_expire_shares();
  if p_share is not null then
    select * into s from shares where id = p_share and from_user = me;
    if s.id is null then raise exception 'Trip session not found.'; end if;
    if exists (select 1 from trips where share_id = p_share) then raise exception 'This trip was already checked in.'; end if;
    if s.trip ? 'routeDistanceM' then route_m := least(p_route_m, (s.trip->>'routeDistanceM')::float); end if;
  end if;
  if p_lat is not null and gw_haversine(p_lat, p_lng, p_dest_lat, p_dest_lng) > 75 then
    reasons := array_append(reasons, 'You are not at the destination yet, so no points were awarded.');
  else
    select count(*) into todays from trips where user_id = me and at::date = current_date;
    if route_m < 200 then reasons := array_append(reasons, 'Trips under 200 m do not earn points.');
    elsif todays >= 8 then reasons := array_append(reasons, 'Daily check-in limit reached.');
    else
      tid := gen_random_uuid();
      perform gw_grant(me, 'trip_completed', 'trip', tid::text, 5); base := 5;
      if s.id is not null and s.trip is not null then
        opt := coalesce(s.trip->'rewardOptIn', '{}'::jsonb);
        if (opt->>s.from_user::text) = 'true' and (opt->>s.to_user::text) = 'true' and s.trip ? 'acceptedAt' then
          bonus_m := case when coalesce((s.trip->>'progressM')::float, 0) > 0 then least((s.trip->>'progressM')::float, route_m) else 0 end;
          select coalesce(sum(bonus_points), 0) into spent from trips where user_id = me and at::date = current_date;
          bonus := greatest(0, least(gw_bonus_for(bonus_m), 40 - spent));
          if bonus > 0 then
            perform gw_grant(me, 'shared_trip_bonus', 'trip', tid::text, bonus);
            perform gw_grant(s.to_user, 'shared_trip_bonus', 'share', s.id::text, bonus);
          elsif bonus_m = 0 then reasons := array_append(reasons, 'No shared-trip bonus: no live progress was recorded along the route.');
          elsif spent >= 40 then reasons := array_append(reasons, 'Daily shared-trip bonus cap reached.'); end if;
        else reasons := array_append(reasons, 'No shared-trip bonus: your friend must accept and both of you must opt in before arrival.'); end if;
      end if;
      insert into trips (id, user_id, share_id, distance_m, bonus_m, bonus_points) values (tid, me, s.id, round(route_m), round(bonus_m), bonus);
    end if;
  end if;
  if s.id is not null and s.status <> 'ended' then
    update shares set status = 'ended', ended_reason = case when p_lat is not null and gw_haversine(p_lat, p_lng, p_dest_lat, p_dest_lng) <= 75 then 'arrived' else 'stopped' end,
      ended_at = now(), trip = trip || jsonb_build_object('arrived', p_lat is not null and gw_haversine(p_lat, p_lng, p_dest_lat, p_dest_lng) <= 75, 'bonusPoints', bonus) where id = s.id;
  elsif s.id is not null then
    update shares set trip = trip || jsonb_build_object('bonusPoints', bonus) where id = s.id;
  end if;
  return jsonb_build_object('basePoints', base, 'bonusPoints', bonus, 'eligibleM', round(bonus_m), 'reasons', to_jsonb(reasons));
end $$;
