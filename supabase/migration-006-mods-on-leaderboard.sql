-- Migration 006 — moderators appear on leaderboards like everyone else.
-- Run once in the Supabase SQL editor after migration-005-manual-points.sql. Safe to re-run.
-- Moderators still only appear if they opted in (Leaderboard tab › privacy switches), exactly like other users.

create or replace function leaderboard_page(p_scope text, p_period text, p_offset int default 0, p_limit int default 20)
returns table (rank bigint, alias text, level int, points bigint, is_me boolean, total bigint)
language sql stable security definer set search_path = public as $$
  with ws as (select (date_trunc('week', now() at time zone 'Europe/London') at time zone 'Europe/London') as start),
  pool as (
    select p.id, p.alias, p.points, p.level_floor from profiles p
    where (
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
    where (
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
  select alias, points, id = auth.uid() from profiles where leaderboard_opt_in order by points desc, lower(alias) limit 25;
$$;
