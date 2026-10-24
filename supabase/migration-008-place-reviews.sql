-- Migration 008 — Explore nearby: community reviews of places (OpenStreetMap POIs).
-- Run once in the Supabase SQL editor after migration-007-mods-on-leaderboard.sql. Safe to re-run.
--
-- Rules enforced here (clients can't bypass them):
--   • One review per person per place; writing again replaces it. 1–5 stars, up to 500 characters.
--   • 5 new reviews per person per day. A review is readable by everyone unless hidden.
--   • Anyone signed in can report someone else's review once. 3 reports from different people hide it
--     automatically; a moderator can restore or hide any review. Every moderator action is logged.
--   • Reviews NEVER award points. Nothing here calls gw_grant / gw_award.
--   • No positions are stored for the reviewer — only the place's own coordinates (public OSM data).

create table if not exists place_reviews (
  id uuid primary key default gen_random_uuid(),
  place_key text not null check (place_key ~ '^(node|way|relation)/[0-9]{1,16}$'),
  place_name text not null default '',
  lat double precision not null, lng double precision not null,
  user_id uuid not null references profiles(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  body text not null default '' check (length(body) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  hidden boolean not null default false,
  hidden_reason text,
  hidden_by uuid references profiles(id) on delete set null,
  report_count int not null default 0,
  unique (place_key, user_id)
);
create index if not exists place_reviews_place on place_reviews (place_key) where not hidden;
create index if not exists place_reviews_user_day on place_reviews (user_id, created_at);

create table if not exists review_reports (
  review_id uuid not null references place_reviews(id) on delete cascade,
  by_user uuid not null references profiles(id) on delete cascade,
  reason text not null default '' check (length(reason) <= 300),
  at timestamptz not null default now(),
  primary key (review_id, by_user)
);

alter table place_reviews enable row level security;
alter table review_reports enable row level security;

drop policy if exists "reviews: visible unless hidden" on place_reviews;
create policy "reviews: visible unless hidden" on place_reviews for select
  using (not hidden or user_id = auth.uid() or gw_is_admin());
drop policy if exists "reviews: delete own" on place_reviews;
create policy "reviews: delete own" on place_reviews for delete using (user_id = auth.uid());
-- No insert/update policies: writes go through upsert_place_review() below.

drop policy if exists "review_reports: own and admin" on review_reports;
create policy "review_reports: own and admin" on review_reports for select
  using (by_user = auth.uid() or gw_is_admin());

-- Write (or replace) my review of a place. Returns the stored row.
create or replace function upsert_place_review(p_place_key text, p_place_name text, p_lat double precision, p_lng double precision, p_rating int, p_body text)
returns place_reviews language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); existing place_reviews; today_count int; r place_reviews; b text;
begin
  if me is null then raise exception 'Sign in to write a review.'; end if;
  if p_place_key !~ '^(node|way|relation)/[0-9]{1,16}$' then raise exception 'Unknown place.'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Choose a star rating from 1 to 5.'; end if;
  b := left(trim(coalesce(p_body, '')), 500);
  select * into existing from place_reviews where place_key = p_place_key and user_id = me;
  if existing.id is null then
    select count(*) into today_count from place_reviews where user_id = me and created_at >= date_trunc('day', now());
    if today_count >= 5 then raise exception 'You have written 5 reviews today — more tomorrow.'; end if;
    insert into place_reviews (place_key, place_name, lat, lng, user_id, rating, body)
      values (p_place_key, left(coalesce(p_place_name, ''), 120), p_lat, p_lng, me, p_rating, b)
      returning * into r;
  else
    -- Editing clears any report-driven hide so the new text gets a fresh look; a moderator hide stays.
    update place_reviews set rating = p_rating, body = b, place_name = left(coalesce(p_place_name, place_name), 120), updated_at = now(),
      hidden = case when hidden_reason like 'reports:%' then false else hidden end,
      hidden_reason = case when hidden_reason like 'reports:%' then null else hidden_reason end,
      report_count = case when hidden_reason like 'reports:%' then 0 else report_count end
      where id = existing.id returning * into r;
    if r.report_count = 0 then delete from review_reports where review_id = r.id; end if;
  end if;
  return r;
end $$;
revoke execute on function upsert_place_review(text, text, double precision, double precision, int, text) from public, anon;
grant execute on function upsert_place_review(text, text, double precision, double precision, int, text) to authenticated;

-- Report someone else's review. 3 reports from different people hide it until a moderator looks.
create or replace function report_review(p_review uuid, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r place_reviews; n int;
begin
  if me is null then raise exception 'Sign in to report a review.'; end if;
  select * into r from place_reviews where id = p_review for update;
  if r.id is null then raise exception 'That review no longer exists.'; end if;
  if r.user_id = me then raise exception 'You cannot report your own review.'; end if;
  insert into review_reports (review_id, by_user, reason) values (p_review, me, left(trim(coalesce(p_reason, '')), 300))
    on conflict (review_id, by_user) do nothing;
  select count(*) into n from review_reports where review_id = p_review;
  update place_reviews set report_count = n,
    hidden = case when n >= 3 and not hidden then true else hidden end,
    hidden_reason = case when n >= 3 and not hidden then 'reports:' || n else hidden_reason end
    where id = p_review;
  return n;
end $$;
revoke execute on function report_review(uuid, text) from public, anon;
grant execute on function report_review(uuid, text) to authenticated;

-- Moderators: hide or restore any review. Logged in admin_actions.
create or replace function admin_set_review_hidden(p_review uuid, p_hidden boolean, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r place_reviews;
begin
  if not gw_is_admin() then raise exception 'Moderators only.'; end if;
  select * into r from place_reviews where id = p_review for update;
  if r.id is null then raise exception 'That review no longer exists.'; end if;
  if p_hidden then
    update place_reviews set hidden = true, hidden_reason = 'moderator:' || left(trim(coalesce(p_reason, '')), 200), hidden_by = auth.uid() where id = p_review;
  else
    update place_reviews set hidden = false, hidden_reason = null, hidden_by = null, report_count = 0 where id = p_review;
    delete from review_reports where review_id = p_review;
  end if;
  insert into admin_actions (admin_id, action, target_user, target_ref, reason)
    values (auth.uid(), case when p_hidden then 'hide_review' else 'restore_review' end, r.user_id, 'review:' || p_review::text, left(trim(coalesce(p_reason, '')), 300));
end $$;
revoke execute on function admin_set_review_hidden(uuid, boolean, text) from public, anon;
grant execute on function admin_set_review_hidden(uuid, boolean, text) to authenticated;

-- Moderation queue: hidden reviews (auto-hidden by reports, or hidden by a moderator), newest first.
create or replace function admin_hidden_reviews() returns table (
  id uuid, place_key text, place_name text, alias text, rating int, body text, created_at timestamptz, hidden_reason text, report_count int, reports jsonb
) language sql stable security definer set search_path = public as $$
  select r.id, r.place_key, r.place_name, p.alias, r.rating, r.body, r.created_at, r.hidden_reason, r.report_count,
    coalesce((select jsonb_agg(jsonb_build_object('alias', pp.alias, 'reason', rr.reason, 'at', rr.at) order by rr.at) from review_reports rr join profiles pp on pp.id = rr.by_user where rr.review_id = r.id), '[]'::jsonb)
  from place_reviews r join profiles p on p.id = r.user_id
  where gw_is_admin() and r.hidden
  order by r.created_at desc limit 100;
$$;
revoke execute on function admin_hidden_reviews() from public, anon;
grant execute on function admin_hidden_reviews() to authenticated;

-- Reviews of one place (visible ones, plus my own even if hidden), with the author's alias.
create or replace function place_reviews_for(p_place_key text) returns table (
  id uuid, user_id uuid, alias text, rating int, body text, created_at timestamptz, updated_at timestamptz, hidden boolean, hidden_reason text, report_count int, reported_by_me boolean
) language sql stable security definer set search_path = public as $$
  select r.id, r.user_id, p.alias, r.rating, r.body, r.created_at, r.updated_at, r.hidden,
    case when r.user_id = auth.uid() or gw_is_admin() then r.hidden_reason else null end,
    case when r.user_id = auth.uid() or gw_is_admin() then r.report_count else 0 end,
    exists (select 1 from review_reports rr where rr.review_id = r.id and rr.by_user = auth.uid())
  from place_reviews r join profiles p on p.id = r.user_id
  where r.place_key = p_place_key and (not r.hidden or r.user_id = auth.uid() or gw_is_admin())
  order by (r.user_id = auth.uid()) desc, r.updated_at desc limit 100;
$$;
grant execute on function place_reviews_for(text) to anon, authenticated;

-- Star summary for a batch of places (for list badges). Hidden reviews don't count.
create or replace function place_review_summary(p_keys text[]) returns table (place_key text, avg_rating numeric, review_count bigint)
language sql stable security definer set search_path = public as $$
  select place_key, round(avg(rating)::numeric, 1), count(*) from place_reviews
  where not hidden and place_key = any(p_keys[1:60]) group by place_key;
$$;
grant execute on function place_review_summary(text[]) to anon, authenticated;

-- My reviews (Profile › My reviews).
create or replace function my_place_reviews() returns table (id uuid, place_key text, place_name text, lat double precision, lng double precision, rating int, body text, updated_at timestamptz, hidden boolean, hidden_reason text)
language sql stable security definer set search_path = public as $$
  select id, place_key, place_name, lat, lng, rating, body, updated_at, hidden, hidden_reason from place_reviews where user_id = auth.uid() order by updated_at desc limit 100;
$$;
revoke execute on function my_place_reviews() from public, anon;
grant execute on function my_place_reviews() to authenticated;
