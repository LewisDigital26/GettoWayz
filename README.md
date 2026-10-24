# GettoWayz

A mobile-first, installable (PWA) navigation app for people who walk, cycle or scoot. Plan routes, see community-reported hazards, suggest missing paths, and earn points when moderators approve your contributions.

**Stack:** plain HTML/CSS/ES modules + [Leaflet](https://leafletjs.com) 1.9.4 from cdnjs. No build step, no framework, no npm install.

## Run it

Any static file server works. The app must be served over `http(s)://`, not opened from `file://` (ES modules and the service worker need an origin).

```bash
cd ghetto-wayz
python3 -m http.server 8787
# open http://localhost:8787
```

Install it as an app from the browser's "Add to Home Screen" / "Install" prompt once served over HTTPS (or localhost).

## What's live vs. demo

| Feature | Default (no config) | With config |
|---|---|---|
| Map tiles | **Live** — OpenStreetMap standard tiles, no key (dark colourways apply a CSS filter). OSM's tile policy is for light use; for a launched app set `TILE_URL` to a provider such as MapTiler, Stadia or Thunderforest (free tiers with a key) | Custom tile URL + attribution via `TILE_URL` / `TILE_ATTRIBUTION` |
| Place search | **Live** — Nominatim (OpenStreetMap) public API, fair-use; sample places merged in | Add `NOMINATIM_EMAIL` (asked by their usage policy) |
| Routing | **Sample** — hand-made example routes between sample places in Coventry; anything else gets a clearly labelled straight-line *estimate* | **Live** via OpenRouteService (`ORS_API_KEY`) or a self-hosted OSRM (`OSRM_BASE_URL`) |
| Geolocation | **Live** — browser Geolocation API, asked for only when needed, never stored | — |
| Accounts, alerts, path suggestions, points, leaderboard, moderation | **Local demo** — `localStorage` on this device only. Not shared with anyone. Seeded with sample users/alerts/paths flagged `sample: true` | Implement the `Backend` interface (below) against your real service |
| Friends, live-location sharing, trip sharing | **Local demo** (or **live** with Supabase, below) — works only between accounts signed in on the same browser (e.g. two tabs; tabs sync via `storage` events). A sample friend (`GW-KERB-H0P1`) auto-accepts and can run a *scripted* trip so you can see the viewer UI. Nothing leaves the device. | Implement the social methods + a `RealtimeProvider` (see below) |

Every route card carries a `Live` / `Sample` / `Estimate` chip and a plain-language "basis" line, and alerts/paths from the seed are labelled *Sample*. Nothing in demo mode is presented as live or verified.

## Community paths in routing

OpenRouteService and OSRM only know OpenStreetMap, so they can't route along a footpath or alley that the community added. The app joins them in itself (`js/providers/communityRouting.js`):

1. It picks up to 2 **approved** community paths that suit the mode and could shorten the trip. Walking uses footpaths, shared paths and steps. Bike and scooter use cycle and shared paths. Driving never uses community paths.
2. It asks the routing engine for *start → path entrance* and *path exit → destination*.
3. It joins these as *leg 1 + community path + leg 2*. Each path end must be within 40 m of a way the engine can reach.
4. It shows the result only if it's at most 25% slower than the engine's quickest route. If it's the quickest overall, it's labelled **Community shortcut**.

The engine legs are live routes. The community section is timed at the mode's average speed and is shown as a 🟢 step. It costs up to 4 extra routing calls per search, and only when an approved path is nearby. Tuning is in `COMMUNITY_ROUTING` in `js/backend/rules.js`.

The long-term fix is to add good, clearly public paths to OpenStreetMap itself, following OSM's rules: only map what you've surveyed. Every routing engine then picks them up.

## Configure real services

Copy `config.example.js` to `config.local.js` (git-ignored) and fill in what you have:

```js
window.GW_CONFIG = {
  ORS_API_KEY: "",        // openrouteservice.org — enables live routing (foot-walking / cycling-regular)
  OSRM_BASE_URL: "",      // alternative: self-hosted OSRM with foot + bike profiles
  TILE_URL: "",           // optional custom tile template; TILE_ATTRIBUTION must match your provider's terms
  TILE_ATTRIBUTION: "",
  NOMINATIM_EMAIL: "",    // your contact email for Nominatim's usage policy
  TOMTOM_API_KEY: "",     // developer.tomtom.com — enables the Live traffic layer (flow tiles + incidents)
  BACKEND: "local"        // swap to your adapter name once added in js/backend/index.js
};
```

Keys live only in `config.local.js` on the client. For production, proxy OpenRouteService through your backend so the key is not shipped to browsers.

### Driving mode

Drive uses the provider's car profile (`driving-car` on OpenRouteService, `driving` on OSRM), which follows OpenStreetMap access rules — cars are never routed onto footways, cycleways, pedestrian zones or private roads. Neither engine supplies live traffic or real-time closures, so travel times are free-flow estimates and every car route carries a **No live traffic** chip. Without a routing provider, Drive shows a clear "needs a routing provider" message rather than a fabricated route. While navigating in Drive the bar is larger, nothing needs tapping except **End**, and voice guidance (browser SpeechSynthesis, en-GB) is on by default with a toggle; walking/cycling can turn voice on too. There are no adverts anywhere in the app.

### Streetlights and night mode

- **Layer control**: map layers (⧉ button) → Streetlights: *Auto (night)* / *On* / *Off*. Auto turns the layer on between sunset and sunrise, computed locally. The badge shows the next sunrise/sunset. Preference is stored on the device.
- **Lamp status** (derived in `deriveLampStatus`): 🟡 *Recently confirmed working* — a `light_ok` report within 14 days; 🔴 *Reported out* — latest report is `light_out` (30-day expiry); ⚪ *Unknown / not verified* — no current report. Tapping a lamp shows the status, when it was last reported, moderator verification, and the report history, plus **Seen it working** / **Report out**.
- **Reports** go through the normal alert system: 5/day, no duplicates per category within 25 m, expire automatically, moderators verify, points only on verification or 2+ confirmations. Zoom ≥ 15 to show lamps.
- **Routing at night**: each route is scored by sampling every 25 m and checking lamps within 30 m — *confirmed* / *reported out* / *unknown* / *no data*. The route card shows `🔦 N% lit·confirmed` and the sheet shows a bar with all four shares and a plain-language sentence (e.g. "66% has no lamp data at all"). On the map the selected route gets a thin warm overlay on confirmed stretches and red on reported-out ones. **Prefer routes with confirmed lighting** appears only at night and only when at least one route has ≥ 20% confirmed coverage; it ranks routes by that share and labels the best "Most confirmed lighting". Nothing is ever described as safe.
- **Privacy**: lamps are fetched for the map view, not the user's position; no route or location history is stored.
- **Lamp positions** come from `data/coventry-lamps.json`, a snapshot of OpenStreetMap `highway=street_lamp` nodes refreshed every Monday by `.github/workflows/lamps.yml` (`scripts/fetch-lamps.mjs`). Outside the Coventry box the app falls back to live Overpass. OSM has only ~500 lamps mapped in Coventry (the council runs ~31,400), so a council FOI dataset can later replace this file as-is.
- **Lit / unlit streets**: `data/coventry-lit.json` (same weekly workflow, `scripts/fetch-lit.mjs`) holds every road/path tagged `lit=yes`/`lit=no` — about a third of the city's 4,100 km walkable network (Oct 2026: 1,071 km lit, 195 km unlit). Drawn at zoom ≥ 15 as an amber glow (lit) or red dashes (dark). Tap a street → **It's lit** / **It's dark** files a `street_lit` / `street_dark` report (180-day expiry, normal 5/day limit). A report changes the street's colour only once it's **trusted**: verified by a moderator or confirmed by 2+ other people. Route scoring counts lit/dark streets after confirmed or reported-out lamps.
- **Street lighting points**: `street_lighting_confirmed` +3 (cap 15/day) to the reporter and `confirm_helpful` +2 to each confirmer, paid once when the 2nd confirmation lands or a moderator verifies — whichever comes first. Needs `supabase/migration-009-street-lighting.sql` on the live backend.

### Live traffic (cheapest setup)

Two sources, both free at test-app scale:

1. **TomTom Traffic API** — car traffic. Sign up at developer.tomtom.com, create a key, paste it into `config.local.js` as `TOMTOM_API_KEY`. The free tier covers roughly 2,500 incident requests and 50,000 tiles a day. The app keeps well inside that: incidents are fetched once per map view, cached 60 s, and only at zoom ≥ 11.
   - **Layer control**: map layers (⧉) → *🚦 Live traffic*. Roads are tinted by current speed vs. free-flow (green / amber / red) and incidents — crashes, closures, roadworks, floods, broken-down vehicles — appear as pins with a dashed line along closures. Tap for the delay, road, and expected clearance time. Preference is stored on the device.
   - **Routing**: every route card shows `🚦 N traffic` when live incidents sit within 30 m of it, and the route sheet lists them under *Live traffic on this route*. The *No live traffic* chip on Drive routes disappears while the layer is on.
   - Drivers are the source, so it covers roads, not footpaths. The copy says so.
2. **Supabase Realtime** — community alerts. Run `supabase/migration-006-realtime-alerts.sql` once; after that every phone with the app open sees a new report, confirmation or moderator review within a second or two, with a toast when a new alert lands within 1.5 km of the user. No extra cost: Realtime is included in the free project.

Before a public launch, move the TomTom incidents call behind a Supabase Edge Function so the key is not shipped in `config.local.js`.

### Explore nearby & community reviews

- **Explore** (home sheet → 🧭 Explore, or any quick-find chip) lists places within 1 km in ~24 categories across four groups (food & drink, shops, services, out & about), straight from OpenStreetMap — searched via Photon (komoot) first, then Nominatim, with Overpass only as a last resort since the public Overpass servers are often down; no key, no cost. Hours, phone and website are filled in from a Nominatim lookup when a place is opened. Results are cached 10 min per spot and the three most-used categories are prefetched when the home sheet opens. Markers use a **shape per group plus the category emoji**, so categories are told apart by more than colour.
- **Place sheet**: directions, and whatever OSM knows (hours, address, phone, website, step-free access, takeaway, outdoor seating, fees). Nothing is invented — if OSM has no detail, it says so.
- **Reviews** (`supabase/migration-008-place-reviews.sql`, `js/ui/explore.js`): signed-in members can leave 1–5 stars and up to 500 characters. One review per person per place (writing again replaces it), 5 new reviews a day. Other members can report a review once; **three reports hide it automatically** until a moderator restores it or keeps it hidden (Moderation queue › Hidden reviews, logged in `admin_actions`). A moderator hide survives edits; a report-driven hide is cleared when the author edits (reports reset, so it gets a fresh look). Profile › My reviews lists yours.
- **Reviews never earn points.** Nothing in the reviews code calls the points functions — it's on purpose, to keep reviews honest.
- **Privacy**: a review stores only the place's own public OSM coordinates, never where the reviewer was. Aliases are shown; emails never are.

### Scooter mode

No public routing engine has a scooter profile. Scooter mode uses the cycling network with scooter speed estimates and says so in the route basis. Check local rules on where e-scooters may be ridden.

## Go live with Supabase (recommended)

Everything — accounts, alerts, paths, points, friends, live sharing, trip rewards — runs on one free Supabase project.

1. **Create a project** at supabase.com (Ireland / eu-west-1 is fine for the UK).
2. **Run the schema**: open the SQL editor, paste all of `supabase/schema.sql`, Run. (Projects created before these features were added: also run `supabase/migration-002-streetlights.sql` then `supabase/migration-003-route-sharing.sql`, then `supabase/migration-004-points.sql`, then `supabase/migration-005-manual-points.sql`, then `supabase/migration-006-realtime-alerts.sql`, then `supabase/migration-007-mods-on-leaderboard.sql`, then `supabase/migration-008-place-reviews.sql`. New projects run schema.sql, then 002 to 008 in order.) If it reports `pg_cron not available`, enable it under *Database → Extensions* and re-run the last `do $$ … $$` block (it expires sessions every minute even when nobody is online; without it they still expire on the next read).
3. **Keys**: *Project Settings → API*. Copy the Project URL and the **anon / publishable** key (never the `service_role` key).
4. **Config**: copy `config.example.js` → `config.local.js`:
   ```js
   window.GW_CONFIG = { SUPABASE_URL: "https://<id>.supabase.co", SUPABASE_ANON_KEY: "<anon key>", BACKEND: "supabase" };
   ```
5. **Auth**: in *Authentication → Providers → Email*, turn **Confirm email** off while testing (otherwise sign-up asks users to click a link first). Accounts are email + password; the email is never shown to other users.
6. **Serve over HTTPS** (GitHub Pages / Netlify / Cloudflare Pages) — browsers only give location to secure pages. Add that URL under *Authentication → URL Configuration*.
7. **Make yourself a moderator**: after signing up, run `update profiles set role = 'admin' where alias = 'your-alias';` in the SQL editor.

What the SQL enforces server-side: all rate limits, points only via `gw_grant()` (clients cannot write `point_entries` or `profiles.points`), share positions readable only by the two participants (RLS), progress along the route computed in `update_share_position()` so clients can't inflate distance, `trip_check_in()` replay-proof via a unique `trips.share_id`, block → sessions ended and positions nulled in one statement. Tested locally against Postgres 16 under the `authenticated` role.

Realtime: `SupabaseRealtime` (in `js/backend/supabase.js`) subscribes to `shares` and `friends` changes; Supabase only streams rows the signed-in user's RLS policies allow, so a user never receives someone else's session.

## Connect a different backend

`js/backend/index.js` documents the interface. Implement it (Supabase, Firebase, your own API…) and register it in `createBackend()`:

```
currentUser, register, signIn, signOut, updateUser, onChange
listAlerts, createAlert, confirmAlert, reviewAlert
listPaths, suggestPath, reviewPath
pointHistory, leaderboard
```

Server-side you must enforce what `localDemo.js` enforces client-side: rate limits (`rules.js`), "no confirming your own report", points granted **only** on moderator approval/verification, and the `admin` role check on review calls. Approved paths should be served to all clients from `listPaths()` — the map and the "More verified paths" labelling read from there.

## Friends & trip sharing

**Flows**
- *Add a friend*: Account → Friends shows your non-sequential ID (`GW-XXXX-XXXX`, copyable). Enter someone's ID → Find → Send request. Lookup returns alias + ID only. They must accept; until then nothing is visible either way. Reject, cancel, remove, block, report, and "who can send me requests" (anyone / nobody) are all in the Friends screen.
- *Share live location*: Friends → Share location → consent screen (who sees it, auto-stop time, one-direction, no history, foreground-only) → pick 15/30/60/120 min → Start. Location permission is requested at that moment. A banner on the map shows who can see you, start/end time, Pause/Stop. The session ends at the chosen time, on Stop, on sign-out, on unfriend, or immediately on block (either direction).
- *Share a route with a friend*: on any planned route, tap **👥 Share route with a friend**. Starting navigation also offers it. You pick exactly **one** accepted friend; nobody is selected by default, and a route is never visible to other friends or on the public map. You can tick **Share my live progress during this trip**, or switch it on later. If you already shared the route while planning, starting navigation asks whether to turn live progress on for this trip.
  - **Invitation.** The friend first sees an *invitation*: who it's from, where to, travel mode, distance and time. They can **Accept** or **Decline**. The route line is only revealed once they accept. No position is ever stored for an invitation, or while live progress is off.
  - **Following.** After accepting, the friend sees your route and travel mode. Your position, % progress and ETA appear **only while live progress is on**. The ETA is worked out from your *last update time*, not from now. If you stop updating, they see "Last update N min ago — this is not their current position".
  - **Banners.** Both people get a banner. Yours shows *Invitation sent*, *Live: X is following your trip*, or *X can see your route · live off*, with **Go live / Pause live** and a red **Stop sharing** button. During navigation the banner moves to the bottom of the screen so Stop is always reachable. Their banner shows the invitation or the live/last-update state, and they can **Stop following**.
  - **When it ends.** Sharing ends when you arrive, press Stop or End, decline/stop following, unfriend or block, or when the time cap is reached (2× ETA + 15 min, max 4 h). The route line and position are deleted at that point. "Arrived" is only recorded if your last position really is within 75 m of the destination. After navigation, the app stops watching your location unless you separately started a live-location share.
  - **Go to a friend.** The home sheet has **🫂 Go to a friend**, which routes to a friend who is currently sharing their location with you. The destination is a snapshot of where they were, labelled with its time. That friend is pre-selected if you then share the route.
  - **No points for sharing.** Sharing never earns points. The existing shared-trip bonus now also requires that the friend *accepted*, and it only counts progress recorded live along the route.
- *Arrival check-in*: on arrival (or End), an optional check-in awards +5 trip points. If **both** people opted into shared-trip rewards, a distance-banded bonus is added for both: 500 m +4 · 1.5 km +8 · 3 km +12 · 6 km +20 (max +20/trip, +40/day). Eligible distance = progress along the chosen route (backend-tracked, monotonic, capped at route length; off-route positions are ignored). Check-ins are rejected more than 75 m from the destination when a position is known, replays are rejected per session, and up to 8 check-ins/day earn points.

**Privacy model (enforced in the backend adapter, must be enforced server-side too)**
- Every social call requires a signed-in user and an accepted friendship. Share rows are readable only by their two participants (RLS). The route line is in a separate `share_routes` table that only the owner, and the recipient *after accepting*, can read. Positions are only written for an accepted share with live on. Only the owner can push positions or change live; either participant can end the share.
- Only the **latest** position of an active session is stored; it is deleted when the session ends. The completed-trip ledger stores distance and points only, no coordinates.
- ID lookups are limited to 10/hour and friend requests to 10/day; blocked users look like they don't exist.
- The web app cannot share in the background. This is stated on the consent screen and shown to recipients as a stale/lost state rather than faked.

**Realtime**: `js/providers/realtime.js` defines `RealtimeProvider { onUpdate(cb), isCrossDevice, note }`. The demo implementation listens to backend changes in this browser. For real users, implement it over WebSockets / Supabase Realtime / Firebase, scoping each subscription to the session ids the signed-in user may see, and keep publishing through `backend.updateSharePosition()` so access checks live in one place.

## Colourways

Account → Appearance (or "Change colourway" on the home sheet) switches between three palettes built from the logo (navy `#202b47`, lime `#aaf129`, teal `#2bb190`): **Night Route** (default), **Deep Navy**, **Daylight**. The choice is stored in `localStorage`; Daylight also swaps the default basemap to CARTO light. Tokens live at the top of `css/app.css`.

## Points, levels & leaderboards

All values live in **one place**: `js/backend/pointsPolicy.js`, which is used by demo mode and the in-app guide. In live mode the **server is authoritative**. `supabase/migration-004-points.sql` seeds the same defaults into `point_rules` (per-rule points and daily caps) and `points_settings` (trip rules and the level curve), and every award is calculated in SQL. To change live values, edit those two tables. Clients never send a points amount.

**Earning (defaults)**

| Action | Points | Daily cap |
|---|---|---|
| Missing path approved by a moderator | +25 | 75 |
| Hazard report verified by a moderator | +8 | 40 |
| Streetlight report verified by a moderator | +3 | 15 |
| Street lighting report (lit/dark) verified **or** confirmed by 2+ people | +3 | 15 |
| You confirmed a report that was then verified | +2 | 10 |
| Verified trip completed: walk, bike or scooter | +4 | 16 completion pts/day (4 trips) |
| Verified drive completed (no distance bonus) | +2 | shares the cap above |
| Trip distance bonus: 400 m +1 · 1 km +3 · 2.5 km +5 · 5 km +8 · 8 km+ +10 | max 14/trip incl. base | 30 |

- **Distance.** Bike and scooter distance counts at 50% of walking distance.
- **Nothing for submitting.** Submitting a report or path, confirming a report, adding a friend, sharing a location or route, or time in the app earns nothing. The old "report confirmed by others" and shared-trip bonus rules are retired; old ledger entries keep their labels.
- **Over the cap.** An award past a daily cap is still recorded as **capped** with 0 points, so users can see why.
- **Rejected work.** Rejected, duplicate or withdrawn submissions never award points.

**Verified trips.** The old self-reported "Check in" award is gone. A trip earns points only if all of this holds:
- It was started with `start_trip` on a planned route.
- While navigating, the app sends a coarse position check about every 30 s (`trip_checkpoint`).
- It covered at least 80% of the route, with at least one on-route check per km (minimum 2).
- It finished within 75 m of the destination (`finish_trip`).
- It took a plausible time for the mode, and no segment was implausibly fast.

How the distance is worked out and protected:
- **Eligible distance** = min(progress along the route, route length, straight line × 1.4). Detours and longer routes never earn more.
- **Fast trips** go to moderator review, not automatic rejection.
- **Only the latest check is kept** during a trip. When the trip ends, the route, last position and destination are deleted; the summary keeps mode, distance band and points.
- **Opt-out.** Trip points can be turned off; navigation works the same. Points are shown only after navigation ends, never during it.
- **Limits.** One trip at a time, 30 trip starts per day, and unfinished trips expire after 6 h.
- **Honest limitation:** a browser can't prove its GPS is genuine. Plausibility checks, caps and moderator review limit abuse, but trip verification is not tamper-proof.

**Ledger & integrity.** `point_entries` is append-only from the app's point of view:
- **Recorded per entry:** user, delta, rule, source type and ID, timestamp, status (`awarded`, `capped`, `reversed`, `reversal`), requested amount, reversal link, reason, actor and policy version.
- **Idempotency.** A unique key on (user, rule, source) plus a per-user row lock mean retries and concurrent requests can't double-award.
- **Reversals.** A reversal adds a negative `reversal` entry and marks the original `reversed`. Nothing is deleted.
- **Balance.** `profiles.points` is updated in the same transaction and always equals the sum of non-reversed awards.
- **Locked down.** The internal functions (`gw_award`, `gw_grant`, `gw_reverse_entry`, `gw_end_shares_between`, `gw_are_friends`, `gw_blocked_either`, `gw_trip_end`) can no longer be called by app users. Before migration 004, `gw_grant` could be called directly over the API.

**Levels.** There are ten levels on a steady curve. The threshold for level n is round to 5 of 25 × (n−1)^1.75: 0, 25, 85, 170, 285, 420, 575, 755, 950 and 1,170 points.
- **Names:** Newcomer, Corner Scout, Block Walker, Shortcut Finder, Wayfinder, Street Mapper, Route Keeper, Local Guide, Neighbourhood Legend, City Cartographer.
- **Reversals and levels.** A user keeps the highest level they reached (`profiles.level_floor`). Reversed points come off their balance and rankings, but their level doesn't drop.

**Leaderboards.** `leaderboard_page(scope, period, offset, limit)` and `leaderboard_me(...)`:
- **Weekly:** Monday 00:00 to Sunday 23:59 UK time. Only `awarded` points count; reversed, capped and pending don't.
- **All-time:** the current balance.
- **Friends:** you plus accepted friends who turned on the friends board (weekly or all-time).
- **Opt-in.** Public and friends visibility are separate opt-ins, both off by default. Moderators follow the same rules.
- **What's shown.** Rows show rank, alias, level and points only: no locations, routes, distances or times.
- **Ties** share a rank (1, 2, 2, 4) and are listed alphabetically.
- **Paging.** Max 50 rows per page and offset ≤ 500.
- **Hidden users** still earn points and levels.

**Moderators.** The moderation screen now also has:
- **Trips held for review:** approve or reject, with a reason.
- **Points lookup by alias:** reverse a single award with a reason, or remove a contribution and reverse all of its awards.
- **Audit log.** Every review and reversal is written to `admin_actions`.

**Setup:** run `supabase/migration-004-points.sql` once after 002 and 003, then 005, 006 and 007. No new environment variables or services.

**Moderator points adjustments (testing):** Profile › App › *Add test points* (moderators only) opens the moderation screen at *Add or remove points*. Enter an alias, an amount (up to ±1000) and a reason. Each adjustment is a normal ledger entry (*Points adjusted by a moderator*) that the user sees in Activity with the reason, is logged in `admin_actions`, and can be reversed from *Points lookup & reversals*. Removals never take a balance below 0; levels already reached are kept. Moderators appear on leaderboards like anyone else once they opt in (`supabase/migration-007-mods-on-leaderboard.sql`).

## App layout & navigation

Five tabs, the same everywhere: **Leaderboard · Friends · Map · Activity · Profile**. Map is the start screen and sits raised in the centre.

| Tab | What's on it |
|---|---|
| Leaderboard | Your rank and points for the chosen board (Everyone / Friends × This week / All-time), top three, full list, who-can-see-me switches, link to the points rules |
| Friends | “Sharing now” card with Stop, your GettoWayz ID, add by ID, friends, requests, sharing history; *Share a trip* uses the route planned on the map |
| Map | Search, travel mode, routes, navigation, report / add path, layers and a full map legend |
| Activity | “Needs you” (friend requests, trip invitations, requested changes) and a feed of trips, points, contributions and sharing, filterable |
| Profile | Avatar, ID, level and progress, level milestones, contributions, location sharing, privacy, notifications, accessibility, app settings |

- **Phones and tablets:** a bottom tab bar that respects the safe area. The map, its sheet and its buttons sit above it.
- **900 px and wider:** a compact side rail, with the same tabs in the same order.
- **While navigating or drawing a path:** the bar hides, so only the directions and End are on screen.
- **Switching tabs:** the map stays loaded underneath, so a planned route, search and zoom survive.
- **URLs:** each tab has its own (`#leaderboard`, `#friends`, `#activity`, `#profile`). Back moves between tabs, and closes an open pop-up first.
- **Signed out:** the map, search, routing and the public leaderboard work. Friends, Activity and private Profile settings show what they're for, with Sign in / Create account. Nothing private is loaded.
- **Device-only settings:** larger text, reduce motion and in-app alerts are stored in `gw:prefs` in localStorage. They are never sent to the server.

## Project layout

```
index.html              app shell
css/app.css             design tokens + styles
js/app.js               wiring: search, routing, navigation, controls
js/map.js               Leaflet wrapper: tiles, routes, pins, draw tool
js/state.js             tiny store
js/providers/           routing.js (ORS / OSRM / sample), geocoding.js (Nominatim), streetlights.js (Overpass / sample + status + scoring), realtime.js, sampleData.js
js/backend/             index.js (interface), localDemo.js, social.js (friends/sharing/rewards), seed.js, rules.js
js/ui/                  tabs.js (tab shell + router), points.js (Leaderboard), friends.js (Friends), activity.js (Activity), account.js (Profile + sign-in), avatar.js; sheet, modal, alerts, paths, admin, streetlights
js/prefs.js             device-only settings: larger text, reduce motion, in-app alerts
sw.js                   caches the app shell for offline launch (tiles/APIs are never cached)
manifest.webmanifest    PWA manifest + icons/
config.example.js       copy to config.local.js
```

## Three builds: web, Android, iOS

There is **one copy of the app code** — the files above, in the repo root. The website is served straight from it, and the Android APK and iOS app are both built from it via `apps/` (Capacitor). Change the code once and all three get it.

```
apps/capacitor.config.json   app id + name for both phone apps
apps/scripts/sync-web.mjs    copies the web code into apps/www before each phone build
apps/scripts/patch-native.mjs adds location permissions (Android manifest, iOS Info.plist)
apps/android/                Android Studio project (APK)
apps/ios/                    Xcode project (needs a Mac or cloud Mac)
```

Step-by-step commands are in [`apps/README.md`](apps/README.md).

## Attribution

Map data and streetlight positions © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via the [Overpass API](https://overpass-api.de). Default tiles © [CARTO](https://carto.com/attributions). Search by [Nominatim](https://nominatim.org). Routing (when configured) by [OpenRouteService](https://openrouteservice.org). Leaflet is BSD-2-Clause.
