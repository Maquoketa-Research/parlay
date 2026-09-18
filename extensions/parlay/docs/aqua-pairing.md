# Aqua pairing from inside Parlay

Sep 17 2026. Read from the Aqua checkout at `~/Documents/GitHub/aqua` (`main` = 0569d7e) and the other
session's in-flight branch (`worktree-agent-a4a2ade117ccf2533` = 2c3e988, plus an uncommitted plugin 0.7.0 that
is what is installed on this machine). Nothing in Aqua was changed; "verified" means read in the code or probed
read-only on this machine today. Implementation: `src/aqua.ts`, wired from `src/extension.ts` and `package.json`.

## 1. The protocol as Aqua implements it

Pairing exists so nobody copies a game key by hand. The Studio plugin has no credential yet, so it can only
ask; a person on the dashboard approves; the key travels back over the plugin's own poll.

### Sequence (main)

```
Studio plugin (no key)                Aqua server                        Dashboard (browser, or Parlay)
─────────────────────                 ───────────                        ──────────────────────────────
POST /api/studio/hello {version} ───► beat "studio:plugin"               (Setup page: "install" instruction drops)
  every 30 s, key or not

[click] Pair this place with Aqua
POST /api/studio/pair ──────────────► pair_requests row: id, 6-char code,
  {universeId, placeId, placeName}     status pending, TTL 300 s
◄── {ok,id,code,status,expires_in}
panel shows the code                                                     SSE "pairing" event ──► GET /api/pairing
GET /api/studio/pair/<id>?wait=25 ──► held ≤30 s, answers on change      dialog: code, place, matched game
  loop until ~300 s                                                      [click] Approve ──► POST /api/pairing/<id>/approve {slug?}
                                      status approved, key = game.ingest_key
                                      games.place_id := placeId (if unset)
                                      or game_places += place (dev copy)
◄── {status:"approved", key, game}
plugin:SetSetting("aqua_key:<placeId>", key)
GET /api/studio/ping?place_id=… (keyed) ► beat "studio:<game>" and
                                          "studio:<game>:<place>"        Setup: "pair" drops, "Studio connected"
```

### Endpoints

| Call | Auth | Body / query | Answer | Where |
|---|---|---|---|---|
| `POST /api/studio/hello` | none | `{version}` | `{ok, server:"aqua"}`; beats `studio:plugin` | `server/routes/studio.py` |
| `POST /api/studio/pair` | none | `{universeId, placeId, placeName}` | `{ok, id, code, status, expires_in}`; 429 when >200 pending overall or >3 for the place | `server/routes/pairing.py`, `pairing.create` |
| `GET /api/studio/pair/{id}?wait=N` | none | N ≤ 30 | same shape; `key` and `game` once approved; 404 once expired | long poll, 0.5 s tick |
| `GET /api/pairing` | dashboard user | | `{requests:[{id, code, universe_id, place_id, place_name, status, age, matched_game:{slug,name}\|null}]}` | match = `db.game_by_universe` ∩ the user's games |
| `POST /api/pairing/{id}/approve` | dashboard user | `{slug?}` | `{ok, game:{slug,name}}`; 400 no matching game, 404 expired, 409 already answered | resolves with `game.ingest_key` |
| `POST /api/pairing/{id}/deny` | dashboard user | | `{ok}`; 404 expired/answered | |
| `GET /api/games` | dashboard user | | `{games:[{slug, name, place_id, universe_id, places:[{place_id, …}], mirrored, …}]}` | `server/routes/games.py`, `deps.game_json` |
| `GET /plugin/AquaStudioPlugin.rbxmx` | none | | the plugin as .rbxmx with `DEFAULT_URL` rewritten to `AQUA_PUBLIC_URL` or the request's own base URL | `studio_plugin.render` |
| `POST /api/plugin/install` | dashboard user | | writes `%LOCALAPPDATA%\Roblox\Plugins\AquaStudioPlugin.rbxmx` from the repo build (`DEFAULT_URL` = `public_url`, i.e. the hosted Aqua when unset) | `studio_plugin.install` |

"Dashboard user" = `deps.current_user`: the `aqua_session` cookie, or, when `roblox_client_id`/`secret` are
unset (`settings().auth_enabled` false), the single **local operator** for any caller with no cookie at all.
Dave's checkout has no `.env` and `aqua.toml` has `roblox_client_id = ""`, so locally every caller is the local
operator. (Verified by reading; the server was down at probe time, so not verified live.)

### Where state lives

- **Pairing request**: Postgres `pair_requests` (id, code, universe_id, place_id, place_name, status
  pending|approved|denied, key, game_slug, game_name, created_at). Swept on every read once older than
  `PAIR_TTL` = 300 s. Code alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no look-alikes), 6 chars.
  `bus.publish("pairing")` on resolve wakes the plugin's long poll; the dashboard also gets it over SSE.
- **The key, plugin side**: `plugin:GetSetting/SetSetting("aqua_key:<placeId>")`, one per place (a shared
  key before 0.4.2 made a second place inherit the first place's game). `aqua_url` is the server URL the panel
  shows; `DEFAULT_URL` applies only while that setting is empty. An unsaved place files under `aqua_key:unsaved`.
- **The paired place, server side**: approving sets `games.place_id` when the game had none (the place code is
  synced from), or `add_place()` into `game_places` when the request's universe differs from the game's (a dev
  copy that is its own experience). So "is this place paired?" = the place id equals `game.place_id` or is in
  `game.places[]` of some game the user can reach. That is what Parlay reads.
- **Presence**: heartbeats table. `studio:plugin` (any plugin said hello, unpaired counts), `studio:<game_id>`
  (a keyed call), `studio:<game_id>:<place_id>` (ping/jobs from that place). `is_live` = beat within 90 s.
  Exposed only inside `GET /api/state` (`server.plugin_seen/plugin_live`, `studio.paired/live`), and
  `/api/state` needs a selected game (404 "no games connected yet" when there are none).
- **Dashboard**: `static/js/views/prompts.js` `checkPairing()` runs on the SSE `pairing` event and every 30 s,
  and opens a dialog per unseen request: code in a keybox, a game select preselected to `matched_game`,
  Deny / Approve pairing. `views/setup.js` derives `installed = plugin_seen || paired`, `paired = studio.paired ||
  synced`, and drops each instruction as its signal arrives.

### Failure modes

Plugin: cannot reach the server (URL, Studio's per-host HTTP prompt for localhost); 429 when the place already
has 3 pending requests (click Pair three times fast); nobody approves within 300 s ("timed out"); denied;
approved for the wrong game, which the next keyed `ping` reports as `place.known=false` and the panel shows as
"This key belongs to X". Server: `approve` 400 when no game of the user's matches the universe and no slug was
given (the dashboard offers the select; Parlay offers a pick); 409 when already answered; 404 after expiry.
A plugin installed by `aqua plugin install` or Setup > Install has `DEFAULT_URL = https://aqua.maquoketa.net`
(the repo build; `public_url` is empty locally), so its panel points at the hosted Aqua until someone types
`http://localhost:8787` once. **That is the plugin installed on this machine right now** (0.7.0, verified by
reading `%LOCALAPPDATA%\Roblox\Plugins\AquaStudioPlugin.rbxmx`).

### What the in-flight branch changes (2c3e988, plugin 0.6/0.7)

- `POST /api/studio/pair` also carries `studioUserId` (`StudioService:GetUserId()`), stored in
  `pair_requests.studio_user_id`. **With sign-in on**: the server refuses a request with no id (409 "plugin too
  old"), one from an account with no Aqua user (403), and one whose person has no dashboard open (409 "open the
  Aqua dashboard … then press Pair again"). "Dashboard open" = `routes/review.py: dashboard_open(user_id)`, a
  per-user counter of live `GET /api/events` SSE connections. `GET /api/pairing` lists only that person's
  requests and only they may approve or deny (`_theirs`). Approving a request from a foreign universe with an
  explicit slug needs one of the approver's keys to reach that universe (`connect.verify_universes`).
  **With sign-in off** (`_mine` returns None) none of this applies: the local operator sees and answers
  everything as before, so nothing changes for Parlay locally.
- `db.create_pair_request` publishes `pairing` on the bus at creation, so the dashboard shows it at once.
- Plugin: a veil over the panel while pairing ("Press Pair on your Aqua dashboard", the code, a Cancel button),
  poll `wait=10`, an unsaved place refuses to pair or sync, `game_json.places[]` gains `synced` and `live`.
- Parlay's embedded dashboard iframe keeps `/api/events` open while the Aqua panel is visible, so under sign-in
  the "dashboard open" check passes whenever the panel is showing.

## 2. The Parlay design

Goal: the person never opens the browser dashboard to pair. Parlay knows the state, does every step it can,
and names the one click that must happen in Studio.

### State the panel shows (`aquaStrip()` in `src/aqua.ts`)

A one-line strip drawn above the dashboard iframe in the Aqua view (`UrlView` in `extension.ts`, pushed with
`postMessage` so the iframe is never reloaded), refreshed when the view renders, every 60 s while visible, and
after a pairing. Decided in this order:

| Fact | How Parlay knows | Strip |
|---|---|---|
| server down | `GET /api/games` fails | (no strip; the view already shows "Aqua is not running" with Start) |
| sign-in on | `/api/games` → 401 | "Aqua has Roblox sign-in on; pair from its Setup page (Parlay holds no session there)." |
| plugin missing | `%LOCALAPPDATA%\Roblox\Plugins\AquaStudioPlugin.rbxmx` absent (same name Aqua's installer writes) | "The Aqua Studio plugin is not installed." **[Install and pair]** |
| no Studio open | `listStudiosViaWindows()` (windows + Studio logs; deliberately not the MCP seat, which Claude Code may hold) | "Open a place in Roblox Studio to pair it with Aqua." |
| places open | each place id against `game.place_id` / `game.places[].place_id` | "100 Fogs: paired with 100 Fogs · bb: not paired" **[Pair Studio]** when any is unpaired |

`$(plug)` in the Aqua view's title bar runs the same command (`parlay.aqua.pair`, "Parlay: Pair Roblox Studio
with Aqua").

### Pair Studio, step by step (`pairStudio()`); each step is a line in Output > Parlay

1. **Server.** `reachable(aquaUrl)`; if down, offer **Start Aqua** (the existing `uv run aqua serve --worker`
   terminal) and wait up to 60 s for it to answer.
2. **Games.** `GET /api/games`. 401 → stop with the sign-in message (proposal A below). Logs the games and
   their place ids.
3. **Place.** `listStudios()` (MCP first, windows fallback). None → "open the place first". Several → quick pick
   showing paired / placeId / unsaved. No place id (unsaved) → stop: Aqua has nothing to file a key under (the
   in-flight server refuses it too). Already paired → modal "already paired with X", **Pair again** to continue
   (a rotated key).
4. **Plugin.** If the file is missing, `GET {aquaUrl}/plugin/AquaStudioPlugin.rbxmx` and write it to the Plugins
   folder. The download endpoint bakes the server's own base URL as `DEFAULT_URL`, so a plugin installed this
   way points at this Aqua from first load (the repo build would point at the hosted one). Then a modal: Studio
   loads local plugins at start (or at once with "Reload plugins on file changes"), reopen the place, allow
   HTTP to localhost when Studio asks, **Studio is ready**.
5. **The Studio click.** Progress notification: *In Studio: Plugins tab > Aqua QA > "Pair this place with Aqua"*.
   Parlay polls `GET /api/pairing` every 2 s for up to 5 min (the request's own TTL) for a request whose
   `place_id` is the chosen place. Cancellable. A request made before Parlay started watching is picked up at
   once.
6. **The code.** Modal: *Studio "100 Fogs" asks to pair with Aqua. Code: ABC234* — Approve / Deny. The code is
   there for the same reason it is on the dashboard: the person sees Studio's panel show the same six letters.
7. **The game.** `matched_game.slug` from Aqua; when Aqua matched none, a quick pick over the user's games
   (Aqua has no game at all → stop and say to connect the experience on Setup; the request waits there 5 min).
8. **Approve.** `POST /api/pairing/{id}/approve {slug}`. The key reaches the plugin over its own long poll;
   the plugin's first keyed ping beats `studio:<game>:<place>` and (0.5+) starts a full sync when the mirror is
   empty. Parlay says so, logs it, and refreshes the strip, which now reads "paired with …".

Why the Studio click stays: the key must end up in `plugin:SetSetting`, and only the plugin's own code can
write its settings. Parlay could create a request itself (`POST /api/studio/pair` is unauthenticated) but the
key would then come back to Parlay's poll, not to the plugin. Removing the click needs Aqua's help (proposal B).

Not done on purpose: no server-side `plugin_seen/plugin_live` in the strip (only inside `/api/state`, which
needs a game); no reset of an installed plugin's `aqua_url` setting (plugin settings are Studio's; the strip
cannot see them either, so a plugin pointed at the hosted Aqua looks "installed, not paired" here — the fix is
typing `http://localhost:8787` in the Studio panel once, or deleting the file so Parlay reinstalls from the
local server).

## 3. Proposed on the Aqua side (for the other session; none required for the local, sign-in-off case)

**A. A session for Parlay when sign-in is on.** `server/routes/auth.py`: `POST /api/auth/token` with body
`{access_token}` = a Roblox OAuth access token Parlay already holds (`vscode.authentication.getSession("roblox")`,
scopes `openid profile`). Behaviour: call Roblox `userinfo` with it, find or create the user as `auth_callback`
does, create a session the same way, and return `{session}` in JSON instead of `Set-Cookie`. Parlay then sends
`Cookie: aqua_session=<session>` on every dashboard call. Same identity and roles as the browser, no new trust.
Until this exists Parlay says "pair from the Setup page" under sign-in.

**B. Zero-click pairing (removing the Studio click).** Two small changes and one plugin change:
`routes/pairing.py`: `POST /api/pairing/start` (dashboard user) with `{universe_id, place_id, place_name,
slug}` creates a request already `approved` for that game (same key/place bookkeeping as `approve_pairing`),
flagged `for_place = true`. `routes/studio.py: studio_hello` reads an optional `placeId` and, when an approved
`for_place` request for that place is younger than the TTL and unclaimed, answers `{…, pair: {id}}`; the plugin
(`hello` loop) then does what `doPair` does after "approved": `GET /api/studio/pair/<id>`, store the key, ping.
Mark the request claimed on that GET so the key is handed out once. Caveat to weigh: `hello` is
unauthenticated, so on a server reachable from a LAN anyone who knows the place id could race for the key
within the TTL; fine for a loopback-only Aqua, questionable hosted. If accepted, Parlay's step 5 becomes
`POST /api/pairing/start` with the ids `listStudios()` already has, and the code disappears.

**C. Presence without a game.** `GET /api/server` (dashboard user) returning `deps.server_info()`, so a client
can show `plugin_seen`/`plugin_live` before any game exists; today that only comes inside `/api/state`.

## 4. Unverified

- End to end against a running Aqua: the server was down when this was written and was not started against
  Dave's data. Every endpoint shape above is from the code, not a live response.
- `webview.postMessage` before the iframe page has finished loading: the strip arrives ≥1 s later (a
  PowerShell call), so in practice the page is ready; if a strip is ever missed, the 60 s tick brings it.
- The other session's uncommitted plugin 0.7.0 may have moved further than the 2c3e988 diff read here.
