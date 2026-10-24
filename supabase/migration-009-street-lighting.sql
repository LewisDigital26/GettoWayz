-- GettoWayz migration 009 — street lighting reports ("this street is lit / dark") + points.
-- Run once in Supabase → SQL Editor after migrations 002–008. Safe to re-run.
--
-- • New alert categories street_lit / street_dark (180-day expiry, same 5/day limit as every report).
-- • New point rule street_lighting_confirmed: 3 points, max 15/day.
-- • Paid ONCE per report when EITHER a moderator verifies it OR 2+ other people confirm it.
--   Confirmers get confirm_helpful (2 pts, max 10/day) at the same moment. gw_award is idempotent per
--   (user, rule, report), so a later moderator verify never pays twice.

-- 1. Categories
alter table alerts drop constraint if exists alerts_category_check;
alter table alerts add constraint alerts_category_check
  check (category in ('blocked','pothole','lighting','closure','flooding','other','light_out','light_ok','street_lit','street_dark'));

-- 2. Point rule
insert into point_rules (key, label, grp, points, daily_cap, retired) values
  ('street_lighting_confirmed', 'Street lighting report verified or confirmed by 2+ people', 'Map contributions', 3, 15, false)
on conflict (key) do update set label = excluded.label, grp = excluded.grp, points = excluded.points, daily_cap = excluded.daily_cap, retired = false;

-- 3. Which rule pays for a verified report
create or replace function gw_alert_rule(p_category text) returns text language sql immutable as $$
  select case
    when p_category in ('light_out','light_ok') then 'streetlight_verified'
    when p_category in ('street_lit','street_dark') then 'street_lighting_confirmed'
    else 'alert_verified' end;
$$;

-- 4. Creating a report: street lighting reports last 180 days
create or replace function create_alert(p_category text, p_lat double precision, p_lng double precision, p_note text)
returns alerts language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); days int; a alerts;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  if (select count(*) from alerts where created_by = me and created_at::date = current_date) >= 5 then raise exception 'Limit reached: 5 reports per day.'; end if;
  if exists (select 1 from alerts where created_by = me and status = 'pending' and category = p_category and gw_haversine(lat, lng, p_lat, p_lng) < 25) then raise exception 'You already have a pending report at this spot.'; end if;
  days := case p_category
    when 'blocked' then 7 when 'pothole' then 30 when 'lighting' then 60 when 'closure' then 14 when 'flooding' then 3
    when 'light_out' then 30 when 'light_ok' then 14
    when 'street_lit' then 180 when 'street_dark' then 180
    else 14 end;
  insert into alerts (category, lat, lng, note, created_by, expires_at)
    values (p_category, round(p_lat::numeric, 5), round(p_lng::numeric, 5), left(coalesce(p_note, ''), 240), me, now() + (days || ' days')::interval)
    returning * into a;
  return a;
end $$;

-- 5. Confirming: street lighting reports pay out at 2 confirmations from other people
create or replace function confirm_alert(p_alert uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a alerts; n int; c record;
begin
  if me is null then raise exception 'Sign in to do this.'; end if;
  select * into a from alerts where id = p_alert;
  if a.id is null then raise exception 'Alert not found.'; end if;
  if a.created_by = me then raise exception 'You can''t confirm your own report.'; end if;
  if (select count(*) from alert_confirmations where user_id = me and at::date = current_date) >= 20 then raise exception 'Confirmation limit reached for today.'; end if;
  insert into alert_confirmations (alert_id, user_id) values (p_alert, me) on conflict do nothing;
  if not found then raise exception 'Already confirmed.'; end if;
  if a.category in ('street_lit','street_dark') and a.status not in ('rejected','resolved') then
    select count(*) into n from alert_confirmations where alert_id = p_alert and user_id <> a.created_by;
    if n >= 2 then
      perform gw_award(a.created_by, 'street_lighting_confirmed', 'alert', p_alert::text);
      for c in select user_id from alert_confirmations where alert_id = p_alert loop perform gw_award(c.user_id, 'confirm_helpful', 'alert', p_alert::text); end loop;
    end if;
  end if;
  -- Every other category: no points here — they only count if a moderator later verifies the report.
end $$;

-- 6. Moderator review uses the shared rule mapping
create or replace function review_alert(p_alert uuid, p_decision text) returns void language plpgsql security definer set search_path = public as $$
declare a alerts; c record;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into a from alerts where id = p_alert;
  if a.id is null then raise exception 'Alert not found.'; end if;
  if p_decision = 'verify' and a.status <> 'verified' then
    update alerts set status = 'verified', reviewed_at = now() where id = p_alert;
    perform gw_award(a.created_by, gw_alert_rule(a.category), 'alert', p_alert::text);
    for c in select user_id from alert_confirmations where alert_id = p_alert loop perform gw_award(c.user_id, 'confirm_helpful', 'alert', p_alert::text); end loop;
  elsif p_decision = 'reject' then update alerts set status = 'rejected', reviewed_at = now() where id = p_alert;
  elsif p_decision = 'resolve' then update alerts set status = 'resolved', reviewed_at = now() where id = p_alert;
  end if;
  insert into admin_actions (admin_id, action, target_user, target_ref) values (auth.uid(), 'alert_' || p_decision, a.created_by, 'alert:' || p_alert);
end $$;

-- 7. "My contributions" shows street lighting awards too
create or replace function my_contributions(p_limit int default 30) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'createdAt' desc), '[]'::jsonb) from (
    (select jsonb_build_object('kind', 'alert', 'id', a.id, 'category', a.category, 'status', a.status, 'createdAt', a.created_at,
      'award', (select jsonb_build_object('status', e.status, 'points', e.points) from point_entries e where e.user_id = auth.uid() and e.ref_type = 'alert' and e.ref_id = a.id::text and e.rule in ('alert_verified','streetlight_verified','street_lighting_confirmed') limit 1)) as x
      from alerts a where a.created_by = auth.uid() order by a.created_at desc limit least(greatest(p_limit, 1), 50))
    union all
    (select jsonb_build_object('kind', 'path', 'id', p.id, 'name', p.name, 'status', p.status, 'createdAt', p.created_at, 'message', p.review_message,
      'award', (select jsonb_build_object('status', e.status, 'points', e.points) from point_entries e where e.user_id = auth.uid() and e.ref_type = 'path' and e.ref_id = p.id::text and e.rule = 'path_approved' limit 1))
      from paths p where p.created_by = auth.uid() order by p.created_at desc limit least(greatest(p_limit, 1), 50))
  ) t;
$$;
