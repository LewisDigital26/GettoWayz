# Ghetto Wayz

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
| Streetlight positions | **Live** — `highway=street_lamp` nodes from OpenStreetMap via the public Overpass API (no key; volunteer-mapped, coverage varies). Working/out status is **never** inferred from the map — it comes only from dated community reports. `STREETLIGHT_SOURCE: "sample"` gives labelled demo lamps; `"none"` disables the layer | Self-hosted Overpass via `OVERPASS_URL`; a council live feed can be added as another provider that sets `liveStatus` on lamps |
| Sunrise / sunset | **Live** — computed locally from the map centre (NOAA solar equations); no network, no stored location | — |
| Routing | **Sample** — hand-made example routes between sample places in Coventry; anything else gets a clearly labelled straight-line *estimate*. Driving shows a "needs a routing provider" message instead of a fabricated route | **Live** via OpenRouteService (`ORS_API_KEY`) or a self-hosted OSRM (`OSRM_BASE_URL`) — walking, cycling and driving |
| Geolocation | **Live** — browser Geolocation API, asked for only when needed, never stored | — |
| Accounts, alerts, path suggestions, points, leaderboard, moderation | **Local demo** — `localStorage` on this device only. Not shared with anyone. Seeded with sample users/alerts/paths flagged `sample: true` | **Live** with Supabase (below) |
| Friends, live-location sharing, trip sharing | **Local demo** (or **live** with Supabase, below) — works only between accounts signed in on the same browser (e.g. two tabs). A sample friend (`GW-KERB-H0P1`) auto-accepts and can run a *scripted* trip so you can see the viewer UI. Nothing leaves the device. | Supabase Realtime |

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

Copy `config.example.js` to `config.local.js` and fill in what you have. Keys live only in `config.local.js` on the client. For production, proxy OpenRouteService through your backend so the key is not shipped to browsers.

### Driving mode

Drive uses the provider's car profile (`driving-car` on OpenRouteService, `driving` on OSRM), which follows OpenStreetMap access rules — cars are never routed onto footways, cycleways, pedestrian zones or private roads. Neither engine supplies live traffic or real-time closures, so travel times are free-flow estimates and every car route carries a **No live traffic** chip. Without a routing provider, Drive shows a clear "needs a routing provider" message rather than a fabricated route. While navigating in Drive the bar is larger, nothing needs tapping except **End**, and voice guidance (browser SpeechSynthesis, en-GB) is on by default with a toggle; walking/cycling can turn voice on too. There are no adverts anywhere in the app.

### Streetlights and night mode

- **Layer control**: map layers (⧉ button) → Streetlights: *Auto (night)* / *On* / *Off*. Auto turns the layer on between sunset and sunrise, computed locally. The badge shows the next sunrise/sunset. Preference is stored on the device.
- **Lamp status** (derived in `deriveLampStatus`): 🟡 *Recently confirmed working* — a `light_ok` report within 14 days; 🔴 *Reported out* — latest report is `light_out` (30-day expiry); ⚪ *Unknown / not verified* — no current report. Tapping a lamp shows the status, when it was last reported, moderator verification, and the report history, plus **Seen it working** / **Report out**.
- **Reports** go through the normal alert system: 5/day, no duplicates per category within 25 m, expire automatically, moderators verify, points only on verification or 2+ confirmations. Zoom ≥ 15 to load lamps; the Overpass query is bounded to the visible area (padded) and cached 10 min.
- **Routing at night**: each route is scored by sampling every 25 m and checking lamps within 30 m — *confirmed* / *reported out* / *unknown* / *no data*. The route card shows `🔦 N% lit·confirmed` and the sheet shows a bar with all four shares and a plain-language sentence (e.g. "66% has no lamp data at all"). On the map the selected route gets a thin warm overlay on confirmed stretches and red on reported-out ones. **Prefer routes with confirmed lighting** appears only at night and only when at least one route has ≥ 20% confirmed coverage; it ranks routes by that share and labels the best "Most confirmed lighting". Nothing is ever described as safe.
- **Privacy**: lamps are fetched for the map view, not the user's position; no route or location history is stored.

### Scooter mode

No public routing engine has a scooter profile. Scooter mode uses the cycling network with scooter speed estimates and says so in the route basis. Check local rules on where e-scooters may be ridden.

## Go live with Supabase (recommended)

Everything — accounts, alerts, paths, points, friends, live sharing, trip rewards — runs on one free Supabase project.

1. **Create a project** at supabase.com (Ireland / eu-west-1 is fine for the UK).
2. **Run the schema**: open the SQL editor, paste all of `supabase/schema.sql`, Run. (Projects created before these features were added: also run `supabase/migration-002-streetlights.sql` and then `supabase/migration-003-route-sharing.sql`. New projects run schema.sql, then 002 and 003.) If it reports `pg_cron not available`, enable it under *Database → Extensions* and re-run the last `do $$ … $$` block.
3. **Keys**: *Project Settings → API*. Copy the Project URL and the **anon / publishable** key (never the `service_role` key).
4. **Config**: copy `config.example.js` → `config.local.js` and set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BACKEND: "supabase"`.
5. **Auth**: in *Authentication → Providers → Email*, turn **Confirm email** off while testing. Accounts are email + password; the email is never shown to other users.
6. **Serve over HTTPS** (GitHub Pages / Netlify) — browsers only give location to secure pages. Add that URL under *Authentication → URL Configuration*.
7. **Make yourself a moderator**: after signing up, run `update profiles set role = 'admin' where alias = 'your-alias';` in the SQL editor.

What the SQL enforces server-side: all rate limits, points only via `gw_grant()`, share positions readable only by the two participants (RLS), route progress computed in `update_share_position()`, `trip_check_in()` replay-proof, block → sessions ended and positions nulled. Tested locally against Postgres 16 under the `authenticated` role.

## Friends & trip sharing

- *Add a friend*: Account → Friends shows your non-sequential ID (`GW-XXXX-XXXX`). Enter someone's ID → Find → Send request. Lookup returns alias + ID only. They must accept first. Reject, cancel, remove, block, report, and "who can send me requests" are all in the Friends screen.
- *Share live location*: consent screen → 15/30/60/120 min → Start. Banner shows who can see you and when it ends, with Pause/Stop. Ends on time, Stop, sign-out, unfriend, or immediately on block.
- *Share a trip*: **Start navigation** offers "Share your trip?" with a friend picker and a separate shared-rewards opt-in. Positions older than 45 s show as "Last seen", older than 2 min as "Connection lost".
- *Arrival check-in*: +5 trip points. If **both** opted into shared-trip rewards: 500 m +4 · 1.5 km +8 · 3 km +12 · 6 km +20 (max +20/trip, +40/day), from progress along the chosen route only.
- Only the **latest** position of an active session is stored and it is deleted when the session ends. ID lookups 10/hour, friend requests 10/day.

## Colourways

Account → Appearance switches between three palettes built from the logo: **Night Route** (default), **Deep Navy**, **Daylight**. Tokens live at the top of `css/app.css`.

## Points & trust rules

- +50 missing path approved · +10 alert verified · +5 your alert confirmed by 2+ users · +2 you confirmed an alert later verified · +5 trip check-in · up to +20 shared-trip bonus
- Submitting earns nothing. Limits: 5 reports, 3 path suggestions, 20 confirmations per day.
- Alerts expire by category (3–60 days). Leaderboard is opt-in and shows alias, points, level only.

## Project layout

```
index.html              app shell
css/app.css             design tokens + styles
js/app.js               wiring: search, routing, navigation, controls
js/map.js               Leaflet wrapper: tiles, routes, pins, lamps, draw tool
js/providers/           routing.js (ORS / OSRM / sample), geocoding.js (Nominatim), streetlights.js (Overpass / sample + status + scoring), realtime.js, sampleData.js
js/backend/             index.js (interface), localDemo.js, supabase.js, social.js, seed.js, rules.js
js/ui/                  sheet, modal, alerts, paths, account, admin, friends, streetlights screens
supabase/               schema.sql, migration-002-streetlights.sql
sw.js                   caches the app shell for offline launch (tiles/APIs are never cached)
```

## Attribution

Map data and streetlight positions © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via the [Overpass API](https://overpass-api.de). Search by [Nominatim](https://nominatim.org). Routing (when configured) by [OpenRouteService](https://openrouteservice.org). Leaflet is BSD-2-Clause.
