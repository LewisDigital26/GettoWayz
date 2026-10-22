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
| Map tiles | **Live** — CARTO dark basemap over OpenStreetMap (attribution shown on map) | Custom tile URL via `TILE_URL` |
| Place search | **Live** — Nominatim (OpenStreetMap) public API, fair-use; sample places merged in | Add `NOMINATIM_EMAIL` (asked by their usage policy) |
| Routing | **Sample** — hand-made example routes between sample places in Coventry; anything else gets a clearly labelled straight-line *estimate* | **Live** via OpenRouteService (`ORS_API_KEY`) or a self-hosted OSRM (`OSRM_BASE_URL`) |
| Geolocation | **Live** — browser Geolocation API, asked for only when needed, never stored | — |
| Accounts, alerts, path suggestions, points, leaderboard, moderation | **Local demo** — `localStorage` on this device only. Not shared with anyone. Seeded with sample users/alerts/paths flagged `sample: true` | Implement the `Backend` interface (below) against your real service |
| Friends, live-location sharing, trip sharing | **Local demo** (or **live** with Supabase, below) — works only between accounts signed in on the same browser (e.g. two tabs; tabs sync via `storage` events). A sample friend (`GW-KERB-H0P1`) auto-accepts and can run a *scripted* trip so you can see the viewer UI. Nothing leaves the device. | Implement the social methods + a `RealtimeProvider` (see below) |

Every route card carries a `Live` / `Sample` / `Estimate` chip and a plain-language "basis" line, and alerts/paths from the seed are labelled *Sample*. Nothing in demo mode is presented as live or verified.

## Configure real services

Copy `config.example.js` to `config.local.js` (git-ignored) and fill in what you have:

```js
window.GW_CONFIG = {
  ORS_API_KEY: "",        // openrouteservice.org — enables live routing (foot-walking / cycling-regular)
  OSRM_BASE_URL: "",      // alternative: self-hosted OSRM with foot + bike profiles
  TILE_URL: "",           // optional custom tile template; TILE_ATTRIBUTION must match your provider's terms
  TILE_ATTRIBUTION: "",
  NOMINATIM_EMAIL: "",    // your contact email for Nominatim's usage policy
  BACKEND: "local"        // swap to your adapter name once added in js/backend/index.js
};
```

Keys live only in `config.local.js` on the client. For production, proxy OpenRouteService through your backend so the key is not shipped to browsers.

### Scooter mode

No public routing engine has a scooter profile. Scooter mode uses the cycling network with scooter speed estimates and says so in the route basis. Check local rules on where e-scooters may be ridden.

## Go live with Supabase (recommended)

Everything — accounts, alerts, paths, points, friends, live sharing, trip rewards — runs on one free Supabase project.

1. **Create a project** at supabase.com (Ireland / eu-west-1 is fine for the UK).
2. **Run the schema**: open the SQL editor, paste all of `supabase/schema.sql`, Run. If it reports `pg_cron not available`, enable it under *Database → Extensions* and re-run the last `do $$ … $$` block (it expires sessions every minute even when nobody is online; without it they still expire on the next read).
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
- *Share a trip*: tapping **Start navigation** offers "Share your trip?" with a friend picker and a separate shared-rewards opt-in. The recipient sees your route, latest position, % progress and an ETA (estimate) under Friends → Sharing, or by tapping your marker on the map. Positions older than 45 s show as "Last seen", older than 2 min as "Connection lost". The session ends on arrival check-in, End/cancel, or its time cap (2× ETA + 15 min, max 4 h). "Share mine back" is a separate opt-in for the recipient.
- *Arrival check-in*: on arrival (or End), an optional check-in awards +5 trip points. If **both** people opted into shared-trip rewards, a distance-banded bonus is added for both: 500 m +4 · 1.5 km +8 · 3 km +12 · 6 km +20 (max +20/trip, +40/day). Eligible distance = progress along the chosen route (backend-tracked, monotonic, capped at route length; off-route positions are ignored). Check-ins are rejected more than 75 m from the destination when a position is known, replays are rejected per session, and up to 8 check-ins/day earn points.

**Privacy model (enforced in the backend adapter, must be enforced server-side too)**
- Every social call requires a signed-in user; share positions are returned only to the session's recipient; non-owners cannot push to or stop a session.
- Only the **latest** position of an active session is stored; it is deleted when the session ends. The completed-trip ledger stores distance and points only, no coordinates.
- ID lookups are limited to 10/hour and friend requests to 10/day; blocked users look like they don't exist.
- The web app cannot share in the background. This is stated on the consent screen and shown to recipients as a stale/lost state rather than faked.

**Realtime**: `js/providers/realtime.js` defines `RealtimeProvider { onUpdate(cb), isCrossDevice, note }`. The demo implementation listens to backend changes in this browser. For real users, implement it over WebSockets / Supabase Realtime / Firebase, scoping each subscription to the session ids the signed-in user may see, and keep publishing through `backend.updateSharePosition()` so access checks live in one place.

## Colourways

Account → Appearance (or "Change colourway" on the home sheet) switches between three palettes built from the logo (navy `#202b47`, lime `#aaf129`, teal `#2bb190`): **Night Route** (default), **Deep Navy**, **Daylight**. The choice is stored in `localStorage`; Daylight also swaps the default basemap to CARTO light. Tokens live at the top of `css/app.css`.

## Points & trust rules (shown in-app under Account → Rules)

- +50 missing path approved · +10 alert verified · +5 your alert confirmed by 2+ users · +2 you confirmed an alert later verified · +5 trip check-in · up to +20 shared-trip bonus
- Submitting earns nothing. Limits: 5 reports, 3 path suggestions, 20 confirmations per day. Duplicate pins within 25 m are blocked.
- Alerts expire by category (3–60 days); verified alerts get a review date.
- Leaderboard is opt-in and shows alias, points, level only. Live location and travel history are never stored or shown.

## Project layout

```
index.html              app shell
css/app.css             design tokens + styles
js/app.js               wiring: search, routing, navigation, controls
js/map.js               Leaflet wrapper: tiles, routes, pins, draw tool
js/state.js             tiny store
js/providers/           routing.js (ORS / OSRM / sample), geocoding.js (Nominatim), realtime.js, sampleData.js
js/backend/             index.js (interface), localDemo.js, social.js (friends/sharing/rewards), seed.js, rules.js
js/ui/                  sheet, modal, alerts, paths, account, admin, friends screens
sw.js                   caches the app shell for offline launch (tiles/APIs are never cached)
manifest.webmanifest    PWA manifest + icons/
config.example.js       copy to config.local.js
```

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Default tiles © [CARTO](https://carto.com/attributions). Search by [Nominatim](https://nominatim.org). Routing (when configured) by [OpenRouteService](https://openrouteservice.org). Leaflet is BSD-2-Clause.
