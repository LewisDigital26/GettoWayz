-- Migration 005 — moderator points adjustments (for testing and for correcting mistakes).
-- Run once in the Supabase SQL editor after migration-004-points.sql. Safe to re-run.
--
-- Only moderators (profiles.role = 'admin') can call admin_grant_points. Every adjustment:
--   • is a normal ledger entry (rule 'manual_adjustment') with the moderator's reason, shown in the user's points history
--   • is written to admin_actions
--   • can be reversed like any other award
-- Clients still never decide points for themselves.

insert into point_rules (key, label, grp, points, daily_cap, retired) values
  ('manual_adjustment', 'Points adjusted by a moderator', 'Adjustments', null, null, false)
on conflict (key) do update set label = excluded.label, grp = excluded.grp;

-- Reversing a negative adjustment gives the points back (the original only handled positive awards).
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
  if e.points <> 0 then update profiles set points = greatest(0, points - e.points) where id = e.user_id; end if;
  return e.points;
end $$;
revoke execute on function gw_reverse_entry(uuid, text, uuid) from public, anon, authenticated;

-- p_points: -1000…1000, not 0. A negative amount never takes a balance below 0. Levels already reached are kept.
create or replace function admin_grant_points(p_alias text, p_points int, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u profiles; n int; ver int; new_total int;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  if p_points is null or p_points = 0 or abs(p_points) > 1000 then raise exception 'Choose an amount between -1000 and 1000 (not 0).'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason (at least 5 characters).'; end if;
  select * into u from profiles where lower(alias) = lower(trim(p_alias)) for update;
  if u.id is null then raise exception 'No user with that alias.'; end if;
  n := case when p_points < 0 then greatest(p_points, -u.points) else p_points end;
  if n = 0 then raise exception 'That user has no points to remove.'; end if;
  select policy_version into ver from points_settings where id = 1;
  insert into point_entries (user_id, rule, points, ref_type, ref_id, status, points_requested, reason, actor, policy_version)
    values (u.id, 'manual_adjustment', n, 'manual', gen_random_uuid()::text, 'awarded', p_points, left(trim(p_reason), 300), auth.uid(), ver);
  update profiles set points = points + n where id = u.id returning points into new_total;
  update profiles set level_floor = greatest(level_floor, gw_level_for(new_total)) where id = u.id;
  insert into admin_actions (admin_id, action, target_user, target_ref, reason)
    values (auth.uid(), 'grant_points', u.id, 'points:' || n, left(trim(p_reason), 300));
  return jsonb_build_object('alias', u.alias, 'points', n, 'total', new_total);
end $$;
revoke execute on function admin_grant_points(text, int, text) from public, anon;
grant execute on function admin_grant_points(text, int, text) to authenticated;
