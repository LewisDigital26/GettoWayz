-- Migration 002 — streetlight reports.
-- Run once in the Supabase SQL editor on projects created with schema.sql before this migration existed.
-- Adds two alert categories used by the streetlight layer. Status is derived from these dated reports only.

alter table alerts drop constraint if exists alerts_category_check;
alter table alerts add constraint alerts_category_check
  check (category in ('blocked','pothole','lighting','closure','flooding','other','light_out','light_ok'));

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
    else 14 end;
  insert into alerts (category, lat, lng, note, created_by, expires_at)
    values (p_category, round(p_lat::numeric, 5), round(p_lng::numeric, 5), left(coalesce(p_note, ''), 240), me, now() + (days || ' days')::interval)
    returning * into a;
  return a;
end $$;
