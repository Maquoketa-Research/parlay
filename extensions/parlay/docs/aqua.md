# Direct pairing in Parlay (September 20, 2026)

Parlay is the pairing client; it does not install or depend on the Aqua Studio plugin.
Open the game project and choose **Pair with Aqua**. Parlay resolves the place from
native Script Sync mappings or the saved project association. If none is known, choose
an open Studio place by name. It never guesses from an unrelated open window or asks
for numeric IDs. Studio MCP supplies the current account when available; otherwise
Parlay uses its Roblox sign-in session or the previous pairing identity. Sign-in is
required when no account identity is available. Dashboard approval remains mandatory.
The place must be registered on the game's Setup page in Aqua.

Parlay uses the same handshake as the current Aqua Studio client:

1. `POST /api/studio/pair` with `placeId`, `universeId`, `placeName`, and `studioUserId`.
2. Display the returned code in Parlay; the user approves the matching code in Aqua.
3. Long-poll `GET /api/studio/pair/{id}?wait=10` until approved, denied, cancelled, or expired.
4. Validate the returned credential with `GET /api/studio/ping?place_id=...` and `X-Aqua-Key`.
5. Store the credential in VS Code SecretStorage, scoped to Aqua URL, place, and user.
   Keep the selected place metadata in workspaceState; never put credentials in webviews.

The account ID is a claim, not authentication. Aqua requires dashboard approval by that
account and enforces game membership. Parlay never calls the approval endpoint itself.
An approved response has `key: string` and `game: string`. Hosted Aqua issues a scoped
user/place token, not the game's shared ingest key. Registered places alone do not
establish a Parlay pairing; status checks require a stored, accepted credential.

This replaces the pairing/install flow only. Exporting Studio instances, applying changes,
and runtime relay capabilities are separate integrations; pairing does not implement them.
Dashboard session authentication for the Issues API remains separate from this credential.

Verified against `Maquoketa-Research/aqua` pairing/studio routes and Studio client.

---

## Historical design notes (superseded for pairing)

The notes below describe the previous plugin-supervision design and proposals. Plugin
installation, key ownership, and pairing instructions below no longer describe Parlay.

# Aqua inside Parlay: issues, evidence, fixes, pairing

Sep 17 2026. Read from the Aqua checkout at `~/Documents/GitHub/aqua` (`main` = 0569d7e) and the other
session's in-flight branch (`worktree-agent-a4a2ade117ccf2533` = 2c3e988, plus an uncommitted plugin 0.7.0 that
is what is installed on this machine). Nothing in Aqua was changed; "verified" means read in the code or probed
read-only on this machine today. Implementation: `src/aquaIssues.ts` (the issues list, the evidence panel, the
fixes; pure text logic in `src/aquaText.ts`, checked by `tools/aqua-check.mjs`) and `src/aqua.ts` (the API
client, the session, pairing), wired from `src/extension.ts` and `package.json`.

Sections 1 to 4 are the pairing protocol and design (unchanged from the first cut). Section 5 is the issues
integration Dave asked for ("relay the fixes into VS Code directly ... click on a button, go to the script and
line numbers ... evidence with why on the right"), section 6 what Aqua has to add for the hosted case.

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

## 5. Issues in Parlay

### What the person sees

The Aqua container in the right sidebar has two views: **Issues** (a tree) over **Evidence** (the webview that
used to be the whole panel). When the folder is a known Aqua game the tree lists its live issues and the panel
waits for a click; when it is not, the panel is the old landing page (Pair with Aqua, Open the dashboard) and the
tree explains why (not paired, Aqua down, sign-in). A status bar item `$(bug) Aqua N` shows the open count and
focuses the list.

1. **Which game.** The folder is the Script Sync target of one Roblox place. Parlay finds the place id in the
   record `Add Roblox Studio project` wrote (`globalState["studioProject:<placeId>"].folder`), else in Studio's
   own `File_Sync_Persistence_Record_V1:<placeId>:*` of an open Studio whose entries' parent folder is this
   folder (`listStudiosViaWindows` + `syncRecordName` + `readSyncRecord`). Then `GET /api/games` and the game
   whose `place_id` or `places[].place_id` is that place. Remembered in `workspaceState["aquaPlaceId"]`.
2. **The list.** `GET /api/state?game=<slug>` → `issues[]` filtered to `kind == "bug"` and status
   open/investigating/patched, sorted critical→low then newest `updated_at`. Row: label = `title`, description =
   `Shop.Buy:105 · ×12` (the last two names of the script's path, the line, the error/report count), icon by
   severity, tooltip with first/last seen and the places seen in.
3. **The click.** The row's command resolves the script (below), opens it with the line selected and centred,
   then fetches `GET /api/issues/<id>/messages` and, when a patch exists, `GET /api/patches/<id>`, and draws the
   evidence page: severity/status, title, the script:line (a link; or why it is not on disk), counts and
   first/last seen and places, the actions, the summary, **Why Aqua thinks so** (verdict, confidence, the
   verifier's reasoning), **Errors from the servers** (each log line with side, server, count, place, time; the
   message and the first eight stack frames with every script:line a link), **Reports** (the players' words),
   **Metrics**, and **Aqua's fix** (title, root cause, summary, the diff coloured).
4. **The actions.** *Apply fix* (when the patch has a diff): each file of the diff is found in the folder,
   hunks are applied in memory (`aquaText.applyHunks`: at its own line, else wherever its old lines are; refused
   if the code under it changed), one `WorkspaceEdit` replaces the documents, they are saved so Script Sync
   ships them to Studio; Ctrl+Z in the editor undoes it. *Fix with Claude* (when the script is on disk):
   `/parlay-fix <file>:<line>-<line> Aqua issue #id (severity): title. <first error message> Seen ×N. <reasoning>`
   typed into the agent terminal. *Open in Aqua*: the dashboard at `/?game=<slug>` in the browser (no per-issue
   link exists; see 6). *Dismiss*: `POST /api/issues/<id>/dismiss {note}` after a confirm (Aqua has no "resolve";
   resolved is what an applied patch makes an issue).
5. **Live.** While the list is visible Parlay holds `GET /api/events` open (SSE; frames `event: <topic>`) and
   re-reads state 1.5 s after an `issue`, `patch` or `job` frame. When the stream cannot be opened (Aqua down, or a
   401 before a session exists) it re-reads every 30 s instead.

### How a script and a line are named

Aqua has no script/line fields. Its issues come from triage over reports, and the reports that name code are
Roblox's own error text: the swept server logs (`servererrors.py`), the Creator Hub error report
(`monitoring.py`) and the relay's client errors. That text reaches Parlay in `issue.evidence` (JSON text, the
verifier's `gather()`: `server_logs[].message` and `.stack`) and in the `errors`-source messages. Roblox writes
the script as its full instance name, two ways, both handled by `aquaText.locate`:

| Form | Example | Where |
|---|---|---|
| `Path:line:` at the head of the message | `ServerScriptService.Shop.Buy:105: attempt to index nil with 'Price'` | Luau runtime errors; `tests/test_fingerprint.py` |
| `Script 'Path', Line N` per stack frame | `Script 'ServerScriptService.UserGenerated.Analytics.PlayerKit', Line 650` | `ScriptContext.Error` traces, Creator Hub `stacktrace`; `tests/test_monitoring.py` |

The first hit across the log lines (message, then stack), then the title and summary, is the row's location.
`game.` is dropped; a client script's runtime path is folded back to the container Script Sync mirrors
(`Players.<player>.PlayerScripts.X` → `StarterPlayer.StarterPlayerScripts.X`, `PlayerGui` → `StarterGui`,
`Backpack`/`StarterGear` → `StarterPack`). Then the Script Sync layout (`X.server.luau` Script, `X.client.luau`
LocalScript, `X.luau` ModuleScript, `init.*` the folder; `StarterPlayerScripts` both under `StarterPlayer/` and at
the top level, which is where Script Sync writes it) gives the candidates, tried in order; if none exists the
name is looked for anywhere in the folder. Not found means not synced (Workspace scripts, for one), and the
panel says so with the full path to find it in Studio's Explorer.

### The API relied on

| Call | Auth | Answer, the parts used |
|---|---|---|
| `GET /api/games` | dashboard user | `{games:[{slug, name, place_id, universe_id, places:[{place_id, name, ...}]}]}` |
| `GET /api/state?game=<slug>` | dashboard user | `issues[]` (`db/rows.py Issue.as_dict()` + `sources`, `channels`, `agent_notes`, `dismissed_because`): `id, title, summary, severity (critical\|high\|medium\|low), status (open\|investigating\|patched\|resolved\|dismissed), kind (bug\|feature), area, report_count, reporter_count, created_at, updated_at, verdict_state, confidence, evidence (JSON text), blocked_on`; `patches[]` (`db.patch_summaries`, no diff): `id, issue_id, status (pending\|queued\|approved\|denied\|applied\|failed), title, files[], root_cause, fix_summary, also_fixes[], created_at, diff_lines`; `counts.issues_open`; `game` |
| `issue.evidence` | | `{reporting:{reports, distinct_players, distinct_servers, sources[], job_ids[], first_ts, last_ts}, server_logs:[{job_id, severity, message, stack, ts, side, fingerprint, count, servers, from_reporter, mentions, place_id?}], analytics:[{metric, during_reports, week_before, change_percent, significant}], reasoning, cited, about_this_game, exploit?}` (`verify.py`) |
| `GET /api/issues/{id}/messages` | dashboard user | `{messages:[{source, author, author_id, content, ts, channel, confidence, ...}]}` (`db/rows.py Message`) |
| `GET /api/patches/{id}` | dashboard user | the `Patch` row with `diff` (`git diff main...branch`, paths relative to the mirror: `ServerScriptService/Shop/Buy.server.luau`), `issue`, `reports`, `outcome`, `preview` |
| `POST /api/issues/{id}/dismiss` | dashboard user | `{note}` → `{ok}`; `POST .../reopen` undoes it |
| `GET /api/events` | dashboard user | SSE; topics `chat, patch, job, issue, agent, incident, pairing`, one frame per topic per second at most, `: beat` every 20 s |

Timestamps are Unix seconds. Every call goes through `aqua.api()`: `{ok, status, data}`, 8 s timeout, and on a
401 from a non-local Aqua one silent session trade (6, A) before giving up.

## 6. What Aqua must add for the hosted case (and what would help)

**A. The token exchange, exactly as Parlay calls it.** `POST /api/auth/token`, JSON body
`{"access_token": "<Roblox OAuth access token>"}` (Parlay's own Roblox session, scopes `openid profile asset:read
asset:write`, from `vscode.authentication.getSession("roblox", ...)`), no cookie. Aqua: `roblox.userinfo(access)`,
`db.upsert_user(...)` as `auth_callback` does (a stranger is a sign-up, not a session), `db.create_session(user_id,
token, session_days)`, answer `200 {"session": "<token>"}`; 401 when Roblox rejects the token, 403 for an account
that has not finished sign-up. Parlay stores the value in SecretStorage `parlay.aquaSession` and sends
`Cookie: aqua_session=<token>` on every dashboard call and on `/api/events`; a 401 later deletes it and trades
again (at most once per five minutes). Until the route exists the trade answers 404, the list shows the sign-in
state, and *Sign in to Aqua* opens the dashboard in the panel for its own sign-in (that cookie lives in the
webview, not in Parlay's fetch, so the list stays empty; the dashboard works).

**Nice to have, in order of value to the panel:**

1. A per-issue link on the dashboard (`/?game=<slug>&issue=<id>` opening the inspector), so *Open in Aqua*
   lands on the issue instead of the game's list.
2. `script`/`line` on the issue row (or on `error_groups`, surfaced in evidence), taken from the same regexes
   at sweep time. Parlay would read them first and keep its own parse as the fallback for old rows.
3. An `/api/games/<slug>/issues` route returning only the live issues with their evidence: `/api/state` carries
   the whole dashboard (events, patches, org, provider) on every refresh.
4. B and C from section 3 stand.

### Unverified

- Not run against a live Aqua: the server was down and the hosted one answers 401; every shape is from the
  code. In particular the exact `stack` text Roblox's server-logs API returns per frame is inferred from Aqua's
  tests and its fingerprint regexes, not from a captured line.
- The panel and tree were type-checked, bundled and checked (`tools/check.mjs`, `tools/aqua-check.mjs`), not
  clicked through in a running Parlay.
