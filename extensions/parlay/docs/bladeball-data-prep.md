# Blade Ball data prep

Written 2026-09-21, before any developer data has arrived. Purpose: get Blade Ball's real analytics and version
history into a shape that pairs with what the Parlay lab (`qa/play.mjs`, personas in `qa/agents.mjs`, Jev policy,
`lab-aggregate.mjs`) measures on the same shipped version, so every Blade Ball release becomes a natural experiment
with a known outcome.

Conventions. **documented** = stated on a Roblox page or in a file we hold. **community-reported** = a DevForum or
wiki post, not staff. **inferred** = follows from documented facts but is not stated anywhere. **estimate** = a
number we made up with a reason. **needs live check** = one authenticated call or one Studio session settles it.
Every table row says which.

Target identifiers (documented, `games.roblox.com/v1/games?universeIds=4777817887`, saved as
`C:\Users\Dave.MAQUOKETA\.claude\jobs\260ad20a\tmp\bladeball\timeline\game_details.json`): universe **4777817887**,
root place **13772394625**, creator group **Wiggity.** (id 12836673), created 2023-06-17T00:05Z, copying not allowed,
`studioAccessToApisAllowed: false`, avatar type still `MorphToR6` on 2026-09-21.

Working files from the research pass live under `C:\Users\Dave.MAQUOKETA\.claude\jobs\260ad20a\tmp\bladeball\`
(`timeline\`, `analytics-ingest\schema.json`, `pairing-analysis\pairing-analysis-plan.md`,
`data-agreements\intake-checklist.md` plus three saved Roblox legal texts). They are job-temp files, not repo files;
section 7 says which to copy into the data folder.

---

## 1. What to ask for: the one-hour intake

The two facts that shape the hour:

1. **Only the performance family of metrics is keyed by place version, and it keeps 28 days.** Retention, DAU,
   session length, revenue, funnels, economy and custom events keep 4 years (1468 days) but have no `PlaceVersion`
   or `Place` dimension (documented, https://create.roblox.com/docs/en-us/cloud/guides/analytics/metrics.md,
   dimension table). So the version-tagged session median, crash rate and peak CCU must start being pulled **this
   week**, and everything else is attributed to a version by its publish-date window. The publish log is therefore
   the most important item in the hour.
2. **Roblox's Creator Third Party App Policy says "Do not request API keys from other Roblox Users"** (documented,
   saved copy `data-agreements\sources\rbx_37924211313044.json`, edited 2026-08-14). So the developer pulls with
   their own key on their own machine and hands over the output; Parlay never holds the credential. If Dave is added
   to the group with a role that can create API keys, he is the "developer" for this purpose.

### 1.1 Checklist (developer side, ~60 minutes)

| # | Item | Minutes | What exactly | Why |
|---|---|---|---|---|
| A1 | **Version history table** | 10 | For place 13772394625: every **published** version with its number, UTC timestamp, notes, and who published. Preferred: page `GET https://develop.roblox.com/v2/assets/13772394625/versions?limit=100&sortOrder=Desc&cursor=...` while logged in as an editor; the documented response has `assetVersionNumber`, `created`, `isPublished` (documented but deprecated, https://create.roblox.com/docs/en-us/cloud/reference/domains/develop.md). Fallback: screenshots of Window > Version History filtered to Published (filters only cover versions after 27 Feb 2026, documented in devforum 4451086). | The spine of the whole dataset. Autosaves outnumber publishes by orders of magnitude; only published rows matter. |
| A2 | **Analytics pull, 4 years** | 15 | Create an Open Cloud API key restricted to Blade Ball, system `universe-analytics`, operation `universe.analytics:read`, 30-day expiry, IP allowlist. Run the section 3 query list (about 25 `OneDay` queries) against `POST https://apis.roblox.com/analytics-query-api/v1/universes/4777817887/metrics`, poll the `202` operation, save one JSON per metric. Zip and send. Delete the key. | One key, one script, PII-free aggregates, repeatable. CSV-by-chart is the fallback and is needed anyway for one chart (A4). |
| A3 | **Weekly PlaceVersion pull, starting now** | 5 to set up | Same key and endpoint: `SessionDurationSecondsP10/P50/P90`, `ClientCrashRate15m`, `ClientCrashCount`, `OomUnexpectedExits`, `PeakConcurrentPlayers`, `ClientFpsP50` with `breakdown: ["PlaceVersion"]`, `OneDay`, last 28 days. Run weekly (Task Scheduler or cron on the developer's machine, or the OAuth route in 2.4). | These are the only real metrics that are exactly keyed by version and they expire after 28 days. Every week of delay loses versions for good. |
| A4 | **Two Creator Hub CSV exports** | 5 | Engagement > "New User First Session Retention" chart, full date range, Export. Acquisition > 30-day payer conversion, if shown. | Neither has an obvious API metric (documented chart, https://github.com/Roblox/creator-docs/blob/main/content/en-us/production/analytics/engagement.md line 57). |
| A5 | **Telemetry inventory** | 10 | Yes/no plus names: AnalyticsService funnels (names, steps), economy events (currencies, `transactionType` values, `itemSku` scheme, what `customField1..3` hold today and how many distinct combinations), custom event names, any GameAnalytics/PlayFab/own backend, any Roblox Experiments (A/B) with dates and arms, any live-ops toggles that change the game without a publish. | Decides whether FTUE completion and first purchase exist as real metrics at all, and whether adding a release label to `customField1` is safe under the 8,000-combination cap. |
| A6 | **Studio access** | 10 | Add the lab account to the group with a role holding "Edit all group experiences" (documented, https://create.roblox.com/docs/projects/collaboration) or per-experience Edit on Blade Ball. Written OK that the lab may open past versions locally and keep frozen `.rbxl` copies until tests finish. State whether they use "Restart servers" on publish. | Section 4 depends on Edit access; a Save to File of a revision is a copy of Wiggity's source and needs their say-so. |
| A7 | **Changelog gap** | 5 | Discord `#updates` posts from 2026-07-12 to today (the public wiki stops at V14.7, 2026-07-11) and the mapping from their version labels (V2.9, V5.0, ...) to place version numbers, if they track it. | The 10 most recent weeks are the ones easiest to open in Studio and the ones still inside the 28-day PlaceVersion window. |
| A8 | **Eight one-line answers** | 5 | (1) publish cadence and how hotfixes differ from features; (2) which places exist in the universe and what each is for; (3) launch/platform/region changes in the period; (4) live-event calendar; (5) can a tester profile be reset; (6) is the shell server-authoritative (purchases, spins) or client-driven; (7) the one metric they watch after a release; (8) who signs the data terms for the group. | Confounders, lab setup, and who can approve. |

### 1.2 Agreement points (one page; details in `data-agreements\intake-checklist.md` section D)

1. Data items: aggregate per day and per version only (section 3). Excluded: any user-level row, Roblox user id,
   username, device id, IP, chat text, the sales-data CSV (it carries `Buyer User ID` per row, documented at
   https://devforum.roblox.com/t/download-your-sales-data/2155610), version contributors, and the Creator Analytics
   **benchmarking** comparisons (the ToU makes those confidential: "use such information only to evaluate the
   performance of your Experience", documented, saved copy `data-agreements\sources\rbx_115004647846.json`).
2. Purpose: build and evaluate a paired benchmark and improve the Experience. The Creator Terms (Effective Date
   May 19, 2026; Zendesk article updated 2026-09-04) grant the Creator use of experience data "for the improvement
   and development of the Experience" and "for business analytics" (documented, same file).
3. Explicit written permission to fit Parlay's predictors on the aggregate series (the App Policy's AI-training ban
   is written about "user data"; aggregates are outside its plain reading, but get it in writing).
4. Publication: normalised or relative results only (lift, rank correlation, hit rate), with written approval per
   publication; never absolute DAU or revenue, never benchmarking comparisons.
5. Storage: local encrypted disk, one named person, no cloud copy, no Aqua ingest, no LLM prompt receives the series
   without a written amendment naming the provider and its retention terms.
6. Retention: 24 months after last delivery or 30 days after request; expunge all API-obtained data if Roblox API
   access is lost (mirrors the App Policy); delete `.rbxl` copies when a version's tests finish.
7. No sub-processors. Studio warrants it may share under the Creator Terms; Maquoketa warrants no re-identification,
   no combining with other user data, no sale.
8. If the developer is the group owner personally, no data-sharing agreement is needed, but every Roblox-derived
   restriction above still applies; write a one-paragraph internal purpose statement.

Three items for a lawyer, in order (none blocks the intake):

1. The Creator Terms say the Creator "will not use or disclose any User data to any third party", do not define
   "User data", and have no vendor/processor carve-out. Whether aggregate daily metrics count is the primary
   question (documented text, inferred gap).
2. If Parlay later registers an OAuth app (2.4), the Creator Third Party App Terms' "Performance Data" clause
   ("You may not collect or aggregate any such data ... to assess the performance or to gain insights into Roblox's
   usage, revenue, or any other aspects of Roblox's business") must be read against a multi-game paired dataset
   (documented, saved copy `data-agreements\sources\rbx_15887203369620.json`).
3. The App Policy's "You may not utilize any user data for the training of AI or language learning models".

---

## 2. Where the data goes and how it is handled

### 2.1 Landing folder

`C:\bladeball-data\` on an encrypted volume. Not inside any git repo (the `drydock-ide` `.gitignore` ignores build
outputs and `secrets.json`, not `*.json`/`*.csv` data; checked 2026-09-21) and not under
`C:\Users\Dave.MAQUOKETA\OneDrive`, which exists and syncs (registry `User Shell Folders` checked 2026-09-21;
`Documents` is not redirected). **Needs check:** BitLocker status (`manage-bde -status` needs an admin shell); if
off, a VeraCrypt container of a few GB. Raw JSON for 4 years of daily series is tens of MB (estimate).

```
C:\bladeball-data\
  raw\<pulled-at-utc>\<metric>[__<breakdown>].json   exactly as received, plus SHA256SUMS
  raw\public\rolimons_*.csv, updates_parsed.json       public sources, copied from the timeline folder
  version.csv            place_id, place_version, created_utc, is_published, save_type, notes, wiki_label, published_at_source
  series.csv             date, metric, dimension, dimension_value, value, status, pulled_at
  real_by_version.csv    one row per published version (section 3.3)
  synthetic_by_version.csv  one row per (version, persona) from lab report.json files
  pair.csv               inner join + deltas + confounders + quality_flags
  prereg.json            frozen hypotheses, sha256 of lab-aggregate.mjs and the pairing script, written before pair.csv exists
  DELETE-BY.txt          date from agreement point 6
```

Schema detail for every column is in `analytics-ingest\schema.json` (valid JSON; tables `version`,
`real_metric_series`, `real_by_version`, `synthetic_by_version`, `pair`). Two corrections to apply to that file
before use: `joins.synthetic_to_version.exactness` must read "exact only if place_version was recorded out-of-band;
`report.placeVersion` is 0 in Studio Play", and `version.published_at` must be marked `estimate=true` until a
timestamp source is confirmed (section 4, step 1).

### 2.2 Handling rules

- The API key never exists on a Maquoketa machine. The developer runs the pull; we receive a zip.
- Aggregate at ingest. The Analytics Query API returns aggregates with no user ids, and small cells come back with
  `status: NotStatisticallySignificant` (documented, https://create.roblox.com/docs/en-us/cloud/guides/analytics.md).
  Keep the status column; never fill missing days with zero (the API omits empty days rather than returning 0;
  community-reported, devforum 4753664, verify on first pull).
- If the developer offers raw backend rows (GameAnalytics, PlayFab, own DB), accept only `(date, release_label)`
  aggregates produced on their side. Raw rows carry Roblox UserIds, which Roblox names as PII
  (documented, https://create.roblox.com/docs/cloud/webhooks/webhook-notifications line 230: "if you store any
  Personally Identifiable Information (PII) of your users, such as their User IDs").
- Nothing from the series goes into Aqua or into a Claude prompt. Claude triage sees lab output only.
- Lab runs cannot contaminate the real side: "Events can only be sent from the server and in published games.
  Events can't be sent from the client or Studio." (documented, verbatim in the funnel, economy and custom-events
  docs). Whether Studio Play sessions feed the PlaceVersion **performance** series is not established; since a
  Studio session reports `PlaceVersion 0` in Play (section 4), any such leakage would land under version 0 and be
  visible.

### 2.3 Separation of duties

The person who runs the lab on a version does not see that version's outcome series until `prereg.json` is written
and the lab rows are final. In practice: lab runs are done and `synthetic_by_version.csv` committed to the folder
before `real_by_version.csv` is built for the same versions.

### 2.4 Repeat pulls

First delivery: developer runs the script. Later: register Parlay as an OAuth 2.0 app in Roblox's "Analytics &
Insights Tools" category, whose scope allowlist gained `universe.analytics:read` and `universe.place:read` effective
2026-06-10 (documented, saved App Policy). The developer authorises once; no key changes hands. Lawyer item 2
applies before doing this.

---

## 3. What Roblox analytics contain, and the per-version schema

### 3.1 The sources

| Source | What it gives | History | Version key | Personal data | Status |
|---|---|---|---|---|---|
| Open Cloud **Analytics Query API** (`POST .../analytics-query-api/v1/universes/{u}/metrics`, async 202 + poll; sibling `/dimension-values`) | 168 metrics in 16 categories; body `{metric, granularity, startTime, endTime, breakdown[], filter[], limit}`; filters In/NotIn/GreaterThan.../Match; `400` code 2001 bad combo or beyond retention, `429` code 3000 data-point budget, `504` code 1000 | 1468 days standard; 90 days matchmaking; 28 days performance | `PlaceVersion` on performance metrics only | none | documented (official guide, GA; the community write-up calls it Beta). Rate limits 30 POST/min per key owner and 3000 polls/min are community-reported (devforum 4753664, 2026-07-23) |
| Creator Hub dashboard **Export** (per-chart CSV) | timestamps and values per KPI, filters Platform/Age/Gender/Country/OS/Source/payer status/engagement segment; blocked for games enrolled < 48 h or with no users in range | "any specific time frame between the first date that the data was available and the present day" (documented); community reports say 2 years (Feb 2026) and 3 years (Jun 2026) | none | none | documented, https://create.roblox.com/docs/production/analytics/analytics-dashboard |
| **Sales data** download (Transactions page, zip by email, one calendar month per request, up to 2 years back) | per-transaction rows incl. `Buyer User ID`, Sale Date/Time UTC, Asset Id/Name/Type, Revenue, Price | 2 years | none | **yes, per row** | documented, devforum 2155610. **Not ingested**; use `ItemMonetizationRevenue` by `ProductKey` instead |
| Place **version history**: `GET https://develop.roblox.com/v2/assets/{placeId}/versions` (cookie, editor) | `assetVersionNumber`, `created`, `isPublished`, `isEqualToCurrentPublishedVersion` | undocumented; developers report 5,000-13,000 versions on old places (community-reported, devforum 1227046) | this is the version list | contributors (drop them) | documented but deprecated, "can incorporate breaking changes without notice" |
| Open Cloud `GET .../place-version-history-api/v1/{placeId}/history` (Experimental; `universe.place:read` or cookie; 1000/min) | `version`, `title`, `description`, `contributors`, `saveType`, `isPublished`; filters `isPublished`, `saveType`, `startTime`, `endTime`, `contributor`, `searchTerm` | same | version list | contributors | documented endpoint; **no timestamp field is documented in the response** (needs live check) |
| Open Cloud Assets v1 `GET .../assets/v1/assets/{placeId}/versions?maxPageSize=50` (`asset:read`) | `path` (`assets/{id}/versions/{n}`), `published` (place-only flag), moderation | same | version list | none | documented; **no date field in the schema** (creator-docs `reference/cloud/assets/v1.json`) |
| **Rolimons** public page for 13772394625 | CCU, visits, favorites, votes, "avg playtime" series; 2023-09-02 to today | game life | none | none | public; **estimate/proxy**. Resolution is mixed: 6 h to 2026-08-21, hourly 2026-08-22 to 09-14, 10-minute from 2026-09-15 |

### 3.2 Metrics the paired dataset uses (exact API names)

| Family | Metrics | Granularity / retention | Useful breakdowns | Notes |
|---|---|---|---|---|
| Retention | `ForwardD1Retention`, `ForwardD7Retention`, `ForwardD30Retention`, `DailyCohortRetention` (by `CohortDay`), `WeeklyCohortRetention`, `DauMauStickiness` | OneDay / 1468 d | Platform, Country, AgeGroupV2, Gender, `AcquisitionSource`, UserSegmentation* | **no `IsNewUser`** (retention is defined on new users), no PlaceVersion |
| Engagement | `DailyActiveUsers`, `MonthlyActiveUsers`, `Visits`, `AverageSessionLengthMinutes`, `AveragePlayTimeMinutesPerDAU`, `TotalPlayTimeHours`, `TotalSessionsEndedInBucket` (by `SessionTimeBucket`) | OneDay / 1468 d | `IsNewUser` (not on TotalSessionsEndedInBucket), Platform, `AcquisitionSource` on DAU | session **mean** only here; the median is in the performance family |
| Monetization | `DailyRevenue` (by `RevenueSource`, `BalanceType`), `AverageRevenuePerUser` (documented as "Average revenue per DAU (ARPDAU)"), `AverageRevenuePerPayingUser`, `PayingUsers`, `PayingUsersCVR`, `ItemMonetizationRevenue` (by `ProductKey`, `ProductType`, `SalesLocation`; also OneHour) | OneDay / 1468 d | Platform, Country, PayerStatus | no `IsNewUser` on revenue |
| Funnels (only if the developer logs them) | `FunnelCohortCompletionRate`, `FunnelCohortSessionCompletionRate`, `FunnelCohortStep1Users` (OneDay); `FunnelStepCompletionRate`, `FunnelStepChurnRate`, `FunnelUserStepCompletionRate`, `FunnelUserTotalCount` and siblings (granularity `None` only: one number per requested range) | 1468 d | `FunnelName`, `FunnelStep`, `IsNewUser`, `CustomField1..3` | 11 metrics in total |
| Economy (only if logged) | `EconomyTransactionCount`, `EconomyTransactionAmount`, `EconomyAverageWalletBalance` | OneDay / 1468 d | `CurrencyType`, `FlowType`, `TransactionType`, `ItemSku`, `IsNewUser`, `CustomField1..3` | first-purchase proxy: `EconomyTransactionCount` with `TransactionType` = the IAP value, by `IsNewUser` |
| Custom events (only if logged) | `CustomEventCount`, `CustomEventCountUser`, `CustomEventAvgValue`, `SumValue`, `Min`, `Max`, `AvgPerUserValue` | OneDay / 1468 d | `CustomEventName`, `CustomField1..3`, `IsNewUser` | |
| Performance and stability | `SessionDurationSecondsAvg/P10/P50/P90`, `ClientCrashRate15m`, `ClientCrashCount`, `OomUnexpectedExits`, `ClientFps*`, `ClientMemoryUsage*`, `ClientCpuTimeAvg`, `PeakConcurrentPlayers` (down to OneMinute) | **28 d** | **`PlaceVersion`**, `Place`, Platform, OS | the only exactly version-keyed real signal; includes a true session-length median |

Documented on https://create.roblox.com/docs/en-us/cloud/guides/analytics/metrics.md (metric rows, retention and
dimension table). What Roblox does **not** expose natively: a per-session quit point, a session-length median older
than 28 days, a first-time-payer count. Proxies: funnel step churn (if logged), `TotalSessionsEndedInBucket`, the
Creator Hub first-session-retention chart, and `SessionDurationSecondsP50` by PlaceVersion for the last 28 days.

### 3.3 `real_by_version`: one row per published version

Attribution column values: `place_version_dimension` (exact, performance metrics, 28 days),
`date_window` (approximate: `[created_utc + rollover_guard, next_created_utc)`, UTC days, versions published
< 24 h apart collapsed into one window keyed on the last one), `custom_field` (exact, forward-only, from the day the
developer ships a release label in `customField1`).

| Column | Real metric and breakdown | Attribution | Notes |
|---|---|---|---|
| `window_start`, `window_end`, `window_days` | from `version.csv` | | `rollover_guard_hours` default 6 (estimate); calibrate from `PeakConcurrentPlayers` by PlaceVersion overlap; ask whether they click "Restart servers" (documented option "Restart only servers with outdated versions", https://create.roblox.com/docs/projects/update-games) |
| `new_users` | `DailyActiveUsers` by `IsNewUser` = true, summed | date_window | |
| `dau_mean`, `visits` | `DailyActiveUsers`, `Visits` | date_window | |
| `d1`, `d7`, `d30` | `ForwardD1/D7/D30Retention`, mean over cohort days in window (cohort = first-play day) | date_window | D1 of the last window day lands under the next version (1 of 7 days); every D7 does. D7 is secondary by design |
| `d1_home` | `ForwardD1Retention` filter `AcquisitionSource` = Home recommendations | date_window | breakdown exists since 2025-10-16 (staff, devforum 4010157); sensitivity analysis only |
| `acq_mix` | `DailyActiveUsers` by `AcquisitionSource`, shares | date_window | confounder |
| `session_len_mean_min`, `playtime_min_per_dau` | `AverageSessionLengthMinutes` (by `IsNewUser`), `AveragePlayTimeMinutesPerDAU` | date_window | |
| `session_bucket_dist` | `TotalSessionsEndedInBucket` by `SessionTimeBucket`, normalised | date_window | share of very short sessions faces lab first-session stalls |
| `session_len_p10_s`, `p50_s`, `p90_s` | `SessionDurationSecondsP10/P50/P90` by `PlaceVersion` | **exact**, 28 d | from the weekly pull only |
| `crash_rate_15m`, `crash_count`, `oom_exits`, `peak_ccu` | `ClientCrashRate15m`, `ClientCrashCount`, `OomUnexpectedExits`, `PeakConcurrentPlayers` by `PlaceVersion` | **exact**, 28 d | |
| `revenue_robux`, `revenue_by_source` | `DailyRevenue` (by `RevenueSource`) | date_window | |
| `arpdau_robux`, `arppu_robux`, `payer_cvr`, `paying_users` | `AverageRevenuePerUser`, `AverageRevenuePerPayingUser`, `PayingUsersCVR`, `PayingUsers` | date_window | |
| `revenue_by_product` | `ItemMonetizationRevenue` by `ProductKey`, `ProductType` | date_window | which surface (pass, spins, packs) |
| `ftue_completion`, `ftue_step_completion` | `FunnelCohortCompletionRate` (OneDay) and `FunnelStepCompletionRate` by `FunnelStep` (granularity None over the window) for the onboarding funnel | date_window, or custom_field once shipped | **only if the developer logs an onboarding funnel** (A5) |
| `first_purchase_new` | `EconomyTransactionCount`, `TransactionType` = IAP, by `IsNewUser` / `new_users` | date_window | **only if economy events are logged**; otherwise `payer_cvr` stands in |
| `first_session_retention` | Creator Hub "New User First Session Retention" CSV | date_window | estimate: chart semantics ("% still playing after X minutes") taken from the doc, export format unverified |
| `public_ccu_daily` | Rolimons daily peak/mean, visits delta | date_window | estimate/proxy; compare across eras only after resampling to 6 h |
| `next_version_delta` | every numeric column, `v` minus `v-1` | | the unit of analysis in section 6 |
| `quality_flags` | `multi_place_universe`, `hotfix_collapsed`, `event_contaminated`, `short_window`, `version_time_estimated` | | `multi_place_universe` settled by `GET https://apis.roblox.com/universes/v1/{universeId}/places` (Experimental; documented on https://create.roblox.com/docs/cloud/reference/features/places.md) |

### 3.4 `synthetic_by_version`: one row per (version, persona)

From `report.json` files via `lab-aggregate.mjs` (today at
`C:\Users\Dave.MAQUOKETA\.claude\jobs\260ad20a\tmp\playmode\persona-lab\lab-aggregate.mjs`, not yet in the repo):
`place_version` (**recorded out-of-band**, section 4 step 7), `persona`, `runs`, `runs_took_steps`, `code_stamp`
(`report.code`), `keys_flagged` (runs-flagged/n with Wilson interval), `error_groups` (console fingerprints, client
and server), `dead_controls`, `stall_cells`, `exploits`, `cov_end`, `first_earn_step`, `shop_reach_step` (first shop
panel open; first `MarketplaceService` prompt), `ftue_max_step`, `steps_to_target`, `done_by`, `screens_seen`,
`hidden_buttons`, `run_seconds`, `model_cost_usd`. Columns marked estimate in `schema.json` (`ftue_max_step`,
`steps_to_first_purchase_ui`) do not exist in today's aggregator and are lab additions (section 7).

---

## 4. Opening a past version in Studio for the lab

Roblox keeps every save of a place as a numbered version and Studio can open any of them without touching the live
one (documented, https://create.roblox.com/docs/projects/version-history: "Open Local Copy ... opens a copy of the
place in a new Studio session"; "Restoring ... creates a new version" and "does not automatically publish").
`game.PlaceVersion` is `0` in Studio Play (recorded n=5, all on lab places, `tmp\playmode\doc-revision\placeversion-tally.json`;
the DataModel reference says it is 0 for unpublished experiences) but non-zero in Studio **Edit** mode, where it is
the version loaded at open (community-reported, devforum 2025271). So the version must be stamped before Play.

| Step | Action | Status | Source |
|---|---|---|---|
| 0 | **Access.** Lab account gets a group role with "Edit all group experiences" or per-experience Edit on Blade Ball. Edit grants Play. Get written OK for local copies (A6). | documented (role, Play); "Edit implies Save to File and owners cannot restrict it" is **community-reported** (devforum 2737283, no staff mark) | collaboration doc |
| 1 | **Version table.** Page `develop.roblox.com/v2/assets/13772394625/versions?limit=100&sortOrder=Desc` with an editor's cookie; keep rows with `isPublished = true`; stop when `created` is earlier than the first analytics date. Fastest with no key at all: the developer opens that URL in a logged-in browser tab and pastes the snippet under 4c into DevTools; it pages to the end and downloads `bladeball-versions.json` (`created` + `isPublished` for every saved version). `revision-extract.mjs --versions-file bladeball-versions.json` then takes the published numbers. Cross-check with Open Cloud Assets v1 `ListAssetVersions` (`asset:read`) if a key exists; the Chrrxs `manage_instance list_place_versions` wrapper drops the `published` flag, so it is not enough on its own. | documented (deprecated route carries `created` + `isPublished`); Open Cloud routes carry **no date** (documented absence); an undocumented time field in `/history` items **needs live check**. Counts from the Version History panel (developer, 2026-09-21): ~1,800 published, ~6,300 unpublished autosaves | develop.md; assets v1.json; places.md |
| 2 | **Map wiki labels to version numbers.** Join `timeline\updates_parsed.json` dates to `version.csv` by "latest publish on the wiki date (UTC), else first publish after it"; developer confirms (A7). | inferred | |
| 3 | **Multi-place check.** `GET https://apis.roblox.com/universes/v1/4777817887/places` once; if more than one place is player-facing, repeat steps 1-2 per place and note which is the start place. | documented endpoint (Experimental) | places.md |
| 4a | **Open the version, preferred.** Resolve Studio's exe from `HKCU\Software\ROBLOX Corporation\Environments\roblox-studio\clientExe` (today `...\Versions\version-55808de4b1914919\RobloxStudioBeta.exe`, 0.739). Run `RobloxStudioBeta.exe --task EditPlaceRevision --placeId 13772394625 --universeId 4777817887 --placeVersion N`. Never Publish or Save to Roblox from that session. | CLI **documented** ("Opens a specific previous version of the place. Requires --placeVersion"). **Live-checked 2026-09-21** on Aqua (Studio 0.739): the window opens in ~12 s, loads `assetdelivery.roblox.com/v1/asset/?id=<place>&version=N` (Studio log), and is titled `Place1 (Version N)`; the bridge lists it under that name with **no** `(placeId: ...)` suffix, so `findStudio` by place id cannot see it: identify it as "the bridge id that was not connected before the launch" (`qa/revision-extract.mjs`). Killing the process by pid leaves no save prompt and nothing in the cloud. Gotcha: Studio honours the launcher's show-window flag, so `spawn(..., { windowsHide: true })` produces an invisible Studio that keeps running. Shares an unknown amount of code with Open Local Copy, which regressed repeatedly in 2026 and was hotfixed 2026-08-28 (staff, devforum 4833788) | https://create.roblox.com/docs/en-us/studio/command-line-interface.md |
| 4b | **Open the version, file route.** Window > Version History > filter Published > ⋮ > Open Local Copy > File > Save to File As `bladeball-vN.rbxl`; sha256 it. Or `GET https://assetdelivery.roblox.com/v2/assetId/13772394625/version/N` with an editor's `.ROBLOSECURITY`, follow `location`, save as `.rbxl`. Open with `--task EditFile --localPlaceFile <abs path>`. | UI documented (filters only cover post-2026-02-27 versions); cookie route **community-reported**; unauthenticated probe returned HTTP 200 with body error 409 "User is not authorized to access Asset" (copylock); whether Open Cloud `asset-delivery-api` with `legacy-asset:manage` serves places **needs live check** | version-history doc; devforum 3391086, 3574403 |
| 5 | **Stamp the version before Play.** Studio MCP `execute_luau` (`datamodel_type: "Edit"`): `return game.PlaceId..":"..game.PlaceVersion`. **Live-checked 2026-09-21:** a 4a session reads `PlaceId 0`, `PlaceVersion 0` and `game.Name = "Place1 (Version N)"` in Edit mode, so the version comes from the CLI argument and the session name only; `revision-extract.mjs` refuses a session whose name does not end in `(Version N)`. Expect `PlaceId 0` for a local `.rbxl` (4b) as well. | Edit-mode non-zero PlaceVersion (devforum 2025271) holds for a normally opened place, not for a revision session; `PlaceId 0` for a local file is inferred. The extension already runs an Edit-datamodel read of `PlaceId`/`GameId` (`src/studio.ts:573`) | Aqua v5 run, 2026-09-21 |
| 6 | **Safety before Play.** Do **not** toggle Game Settings > Security > "Enable Studio Access to API Services": it is a universe-level setting saved to Wiggity's live configuration. The public flag `studioAccessToApisAllowed` is `false` today, so a 4a session cannot reach production DataStores unless the developer changes that. Prefer 4b for Play (a local file has no universe). Additionally set `HttpService.HttpEnabled = false` in the Edit datamodel before Play so old code cannot fire webhooks or analytics. | documented (setting is universe-level; public flag); whether `execute_luau` may write `HttpEnabled` (LocalUserSecurity per the API dump) **needs live check** | game_details.json; api-dump |
| 7 | **Run.** `node qa/play.mjs --place 13772394625 --universe 4777817887 --place-version N --out .build/qa/bladeball-vN-<ts>` (4a) or without `--place` (4b). `--place-version` is a one-line runner addition (`report.placeVersion ??= a.placeVersion`, next to `qa/play.mjs:293`, which today fills it from the Play server probe and therefore reads 0). Copy `version.csv` row and `.rbxl` sha256 into the run folder. | runner change, not yet written | `qa/play.mjs:283-296`, `qa/probe.server.luau:8` |
| 8 | **Fresh-player state.** If the shell is gated on DataStore/ProfileStore data, a 4b session sees no profile and may show a first-run shell for free; if the developer's dev-commands include a profile reset, run it before each run (A8.5). | inferred | play-mode-research.md 7.2 (Poop needed `DevCommands ResetData`) |
| 9 | **Tear down.** Close Studio, discard on the save prompt so no new version lands in Blade Ball's history; delete the `.rbxl` when the version's tests finish (agreement point 6). | inferred | version-history doc (Restore creates a new version) |

**4c. Dialog-free per-version extraction (tested 2026-09-21 on Aqua).** `node qa/revision-extract.mjs --place P
--universe U --versions 4,7,22` (or `--from A --to B --step S`) opens each version with 4a, finds the window by new
bridge id, checks that the session name ends in `(Version N)`, reads the tree with read-only Luau one service at a
time (names, classes, attributes, script `Source`, `Value`, `Text`, part position and size) in chunks of at most
120 KB (the plugin caps one result near 200 KB), writes `~/Documents/Parlay/data/versions/<place>/vN.json`, and
kills the Studio process by pid so no save prompt appears. 28-47 s per version on Aqua; versions already on disk are
skipped. No Luau API writes an `.rbxl`: `PluginManager():ExportPlace(path)` is the OBJ mesh export and opens its
dialog whatever the argument, and `AssetService:SavePlaceAsync` writes to the cloud (never call it). Byte-exact
`.rbxl` files therefore still need 4b: manual Save to File As, or the cookie download. The auto-mode permission
classifier in the Claude session refused to launch this script against Blade Ball itself (a third-party place), so
the developer runs the sweep command; the Aqua runs above are the only ones an agent has executed.

Version-table snippet for step 1 (the developer runs it in the DevTools console of a logged-in tab that is already
on `https://develop.roblox.com/v2/assets/13772394625/versions?limit=100`, same origin, read-only):

```js
(async () => {
  const id = 13772394625, rows = [], seen = new Set();
  let cursor = "", page = 0;
  while (true) {
    const url = `https://develop.roblox.com/v2/assets/${id}/versions?limit=100&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(url, { credentials: "include" });
    if (r.status === 429) { console.log(`page ${page + 1}: rate limited, waiting 30 s`); await new Promise((f) => setTimeout(f, 30000)); continue; }
    if (!r.ok) throw new Error(`page ${page + 1}: HTTP ${r.status}`);
    const b = await r.json();
    let fresh = 0;
    for (const v of b.data) if (!seen.has(v.assetVersionNumber)) { seen.add(v.assetVersionNumber); rows.push(v); fresh++; }
    page++;
    if (page % 10 === 0) console.log(`page ${page}: ${rows.length} versions, ${rows.filter((v) => v.isPublished).length} published, oldest so far ${rows[rows.length - 1].created}`);
    if (!fresh) { console.warn("a page brought nothing new; the cursor is stuck, stopping"); break; }
    if (!b.nextPageCursor) break;
    cursor = b.nextPageCursor;
  }
  console.log(`done: ${rows.length} versions, ${rows.filter((v) => v.isPublished).length} published`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ placeId: id, fetchedAt: new Date().toISOString(), data: rows })], { type: "application/json" }));
  a.download = "bladeball-versions.json"; a.click();
})();
```

(The first draft of this snippet never assigned `cursor = b.nextPageCursor`, so it re-fetched page one forever and
the count climbed past 250,000 before the developer noticed. The version above advances the cursor, de-duplicates by
version number, stops when a page brings nothing new, and waits out HTTP 429.)

Volume: the Version History panel shows ~1,800 published versions and ~6,300 unpublished autosaves (developer,
2026-09-21). Only published versions are opened. At 1-2 minutes per version on this PC, all 1,800 is 30-60 hours
of an unattended Studio; a first pass of every 10th published version (~180, 3-6 hours) followed by densifying
between neighbours that differ is the cheaper order. Dave's hand-saved copies so far
(`~\Documents\Blade Ball Versions\Place1 (Version N).rbxl`, N = 4, 7, 22, 31, 36, 80) are 0.2 MB each.

Live-check results (2026-09-21, one Studio session on Aqua Multi-Place Testing, Studio 0.739):
(a) answered: `EditPlaceRevision` opens; the bridge lists the window as `Place1 (Version N)` with no `(placeId: ...)`,
so find it by new bridge id. (b) answered, negative: Edit-mode `game.PlaceVersion` is 0 in a revision session
(`PlaceId` 0 too); the version is the CLI argument, echoed in the session name. (c) Play-mode reads 0 (earlier, n=5).
Still open: (d) `EditFile` of a saved `.rbxl` reports `PlaceId 0`; (e) `execute_luau` can set `HttpEnabled`. With
Blade Ball access: (f) Open Cloud `ListAssetVersions` and `/history` item shapes for a place; (g) whether
`asset-delivery-api` serves a place version; (h) whether a non-owner editor can Restore (avoid needing to know:
never Restore).

---

## 5. Blade Ball's update timeline

Public sources: the Blade Ball Fandom wiki `Updates` page transcribes the developer's Discord `#updates` changelog
(fetchable via `bladeball.fandom.com/api.php?action=parse&page=Updates`; the HTML page is 403 to fetchers); Rolimons'
embedded CCU series; the Roblox games API; Naavik (2023-10-24); the Roblox Wiki event pages. Full data:
`timeline\bladeball_updates_all.csv` (164 rows: date, version, per-topic flags, shell/core touch, shell and core
change text, CCU 7 days before/after, source per row), `timeline\bladeball_major_updates_curated.csv` (100
hand-summarised rows), `timeline\bladeball_milestones.csv`, `timeline\rolimons_ccu_daily.csv`.

Cadence (computed from the CSV, 2026-09-21): 164 dated updates from V1.0.1 (2023-08-20) to V14.7 (2026-07-11);
23 in 2023, 59 in 2024, 54 in 2025, 28 in 2026 to July. 133 fall on a Saturday, 31 are off-cycle (15 Sun, 7 Mon, 3
Tue, 2 Wed, 3 Thu, 1 Fri: hotfixes and holiday drops). Median gap 7 days; 136 gaps of 6+ days; 18 gaps of 3-5 days;
9 gaps of 1-2 days. Merging versions published 2 days or less after the previous one gives **155 windows**. The
public log is stale after 2026-07-11 (wiki last edited 2026-07-14); the universe kept updating (games API `updated`
2026-09-21), so ~10 more weekly windows exist that only the developer can label (A7).

Shell vs core (two automated passes disagree, so both are shown; hand-coding is required before analysis):
the CSV's topic-flag pass marks 28 shell-only, 135 both, 1 core-only, 0 neither; a tighter keyword pass in the
pairing plan gave 82 shell-only, 79 both, 1 core-only, 2 neither. Weekly updates almost always ship swords, emotes
or abilities alongside shell changes, and about half (86/164) name a paid cosmetic Pack.

### 5.1 Milestones and structural shell changes (S = shell, C = core loop, E = platform/brand event)

| Date | Version | What changed | S/C/E | Lab can see it | Source |
|---|---|---|---|---|---|
| 2023-06-17 | - | Place created | - | - | games API |
| 2023-08-20 | V1.0.1 | Small tutorial + death tips; UI refresh; ball physics | S+C | yes (tutorial) | wiki Updates |
| 2023-09-02 | V1.0.9 | Full UI revamp; contextual tutorial; time-spent bonuses; invite button; Limited skin shop; codes | S+C | yes | wiki; CCU 7d before 9.6K -> after 141K (TikTok virality Sep 7-9, Naavik) |
| 2023-09-23 | V1.3 | Second full UI rebuild in 3 weeks; gifting; playtime awards; 3 coin spins/day | S | yes | wiki |
| 2023-10-01 | V1.3.5 | Swap ability, Prince Blade, Quarry map; ball max speed change | C | no | wiki (press coverage lags 16 days) |
| 2023-10-14 | V1.5 | First Battle Pass (Halloween); team rewards; quests | S+C | yes (pass, quests) | wiki; CCU peak 351K Oct 15 |
| 2023-11-18 | V1.6.3 | VIP+ as Roblox Subscription; 7/30-day login rewards; Duos; gift wheel; Serpent live event | S+C | yes (login, shop) | wiki; all-time peak CCU 511,924 on 2023-11-19 (Rolimons header) |
| 2023-10-22 | - | 1B visits (between 2023-10-21 18:00 and 10-22 00:00 UTC; 50/62/127-day claims count from Sep 2, Aug 21, Jun 17 respectively) | - | - | Rolimons; KreekCraft; Pocket Tactics |
| 2024-01-20 | V2.2 | Pulse rework (core ability balance) | C | no | wiki |
| 2024-02-24 | V2.7 | NEW LOBBY; tournaments; ranked queue from lobby; hotfix V2.7.3 on Feb 27 | S | yes | wiki |
| 2024-03-10 | V2.9 | Major Battle Pass rework (3D, 60 rewards); new AFK World; Merchant + Stars currency; daily race | S | yes | wiki |
| 2024-03-15 | V2.9.3 | The Hunt: First Edition (Mar 15-30) | E | - | wiki; daily CCU 39-43K -> 66-88K on Mar 15-17 |
| 2024-03-23 | V3.1 | Godzilla x Kong collab | E | - | wiki |
| 2024-04-27 | V3.6 | Welcome Back Rewards (21-day lapsed); Dungeons PvE; lobby QoL | S+C | yes (return flow) | wiki |
| 2024-05-23 | V4.0 | The Classic (May 23-28) | E | - | wiki; daily CCU 42-48K -> 70-88K during the event |
| 2024-08-01 | V4.9.8 | The Games (Aug 1-11) | E | - | wiki; **no lift Aug 1-9** (39-58K) |
| 2024-08-10 | V5.0 | TRADING plaza, booths, listings, RAP leaderboards; Cyber BP | S | yes | wiki; daily peak 100,138 on Aug 10, mean 52K -> 83K Aug 11: the clearest public CCU response to a shell change |
| 2024-11-30 | V6.5 | Ability balancing pass | C | no | wiki |
| 2025-04-05 | V8.3 | Ability balancing pass | C | no | wiki |
| 2025-04-26 | V8.6 | LEGO Group collab (through Ninjago V9.5, 2025-06-28) | E | - | wiki; flat CCU |
| 2025-05-03 | V8.7 | Ranked UI; training in lobby; improved UI | S | yes | wiki |
| 2025-06-07 | V9.2 | Player Profiles; shop stock refresh; V9.2.1 Jun 10 profile bug fixes | S | yes | wiki |
| 2025-08-09 | V10 | Balancing incl. increased ball speed | C | no | wiki |
| 2025-09-20 | V10.6 | Update Crate replaces Update Gift (per wiki page `Update_Gift`) | S | yes | wiki |
| 2025-10-16 | - | Roblox adds retention by acquisition source (platform change, not a Blade Ball version) | - | - | devforum 4010157 (staff) |
| 2025-12-06 | V11.7 | "Gift Later" purchase flow | S | yes (shop) | wiki |
| 2025-12-28 | V12 | Lag Ball netcode toggle | C | no | wiki |
| 2026-01-24 | V12.4 | Balancing pass | C | no | wiki |
| 2026-02-09 | V12.5 | Infinite Battle Pass overhaul; daily Limited Shop; premium selection crate | S | yes | wiki; Feb CCU flat (28K peak) |
| 2026-04-18 | V13.5 | Client performance / lag fixes (V13.6 Apr 25: generic "performance improvements") | C | partly (errors, fps) | wiki |
| 2026-06-06 | V14.2 | Kill cams, kill cards, profile overview UI; Rebound LTM | S+C | yes (UI) | wiki |
| 2026-06-20 | V14.4 | World Cup endless Battle Pass; Soccer mode; Tsunami ability | S+C | yes (pass) | wiki |
| 2026-07-11 | V14.7 | R6 -> R15 avatar conversion ("expect bugs") | C/platform | partly (errors) | wiki; games API still says `MorphToR6` on 2026-09-21, so shipped-or-reverted is **unverified** |
| 2026-07-12 .. 09-21 | ? | ~10 unlogged weekly updates; wiki pages created in the gap name packs, Ranked Seasons 18-20, Serpentbane | ? | ? | wiki recentchanges; A7 |
| 2026-09-17 .. 09-28 | ? | The Hunt: Roblox 20 (Roblox 20th anniversary event); Blade Ball has a Tix quest, Serpent boss, badge | E | - | roblox.fandom.com and bladeball.fandom.com event pages; daily CCU 19K -> 28K/36K/46K on Sep 18-20, visits/day 1.7M -> 5.2M. Treat 2026-09-17..28 as `event_contaminated` |

Other platform events with no changelog line: Winter Spotlight (2024-12-17 to 2025-01-02) and The Hatch (2025-07-02
to 07-12; badge confirmed in the Roblox Wiki badge table). Add them to the exclusion list.

Public CCU is a coarse proxy for exposure, not retention: it is dominated by virality (Sep 2023) and platform events,
and monthly aggregation hides one-week lifts (The Hunt and The Classic both show ~2x launch-weekend lifts in the
daily series that vanish in monthly peaks). Use daily means and visits deltas, which are resolution-robust; drop the
single Rolimons `avg_playtime` sample at 2026-09-15 18:20 (3066 min) and optionally 2024-11-12 00:00 (25.35).

---

## 6. The pairing analysis plan

Full text with power tables: `pairing-analysis\pairing-analysis-plan.md`. This section is the corrected summary.

### 6.1 Unit

The **version-window** `w_v = [publish(v), publish(v+1))`, versions published 2 days or less after the previous one
merged into the earlier window with the last hotfix as the build. Cohorts attributed to the version live on their
first-play day (intent to treat). Expected n: **155 windows** from the public log (all with 4-year analytics), plus
~10 unlogged recent ones; ~100 if the funnel/economy signals only exist for part of the history. Before the join,
exclude windows flagged `event_contaminated` (section 5 events), platform outages, and versions that fail to load in
Studio, each with a written reason.

### 6.2 Outcomes (real side)

| Id | Outcome | Role | Note |
|---|---|---|---|
| Y1 | `d1` (all sources), mean over cohort days in the window | **primary** | `d1_home` as a pre-registered sensitivity on windows after 2025-10-16 only; the pair straddling that date is excluded from the source-split analysis |
| Y2 | `d7` | secondary | every D7 return lands under `v+1`; stated leak |
| Y3 | `first_session_retention` (Creator Hub CSV) | secondary | closest real analogue of what the lab sees |
| Y4 | `first_purchase_new` if economy events exist, else `payer_cvr` | secondary | the sales CSV cannot give "new payer / new user" without user-level rows; not used |
| Y5 | `session_len_mean_min`; `session_len_p50_s` where the 28-day PlaceVersion pull covers the version | secondary | |

De-confounding, in order: adjacent differences `ΔY(v) = Y(v) - Y(v-1)` (the workhorse); acquisition-mix covariate;
event exclusion list; calendar covariates (US school year, holidays, summer); public CCU basket of nearby top-100
games as a platform-shock covariate. The Creator Hub benchmark band ("Games with similar players", shown as a
50th-90th percentile range) is not exportable as far as we know; if it is, use the 50th percentile as a residual
baseline, else skip.

Effect-size anchor: the one public onboarding-adjacent experiment (Cookie Cats gate 30 -> 40, n = 90,189, a
progression-pacing change, not a menu change) moved D1 by -0.59 pp (p = 0.074) and D7 by -0.82 pp (p = 0.0016).
**Working assumption (estimate):** a shell change moves D1 by 0.5-2 pp against week-to-week drift of similar size,
so true rho is 0.3-0.5. Sampling error in Y is negligible at Blade Ball's cohort sizes (estimate from 6.4B visits);
the noise that matters is drift, which is why the design is differences, not levels.

### 6.3 Predictors (synthetic side)

Per version, fresh state, K runs per persona (newbie 20, ui 10, explorer 10, breaker 10). Every predictor is a share
of runs with a Wilson interval or a median step, never a note count.

| Id | Predictor | Expected sign vs ΔD1 | Varies across Blade Ball versions? |
|---|---|---|---|
| P1 | lost rate: newbie runs with a `confusing` note (3-step streak, `qa/agents.mjs:57`; flag threshold 0.7 in `qa/policy-jev.mjs:186,190`) | negative | medium |
| P2 | T_reward: median step of `firstEarn`, censored share alongside | negative | medium |
| P3 | T_goal: median step to "reach queue/arena" (not a match; solo Play may never start one) | negative | low; may censor everywhere |
| P4 | **shop reach**: median step to first shop panel open and to first `MarketplaceService` prompt; share reaching it. (Not earn-then-buy: Blade Ball's coins come from the parry loop the lab cannot play, and a Studio Robux prompt is a test purchase anyway) | negative vs Y4 | medium |
| P5 | dead time: share of steps in `still`/`stuck` streaks | negative | medium |
| P6 | dead controls: keys flagged in >= half of a persona's runs | negative | low (polished shell, ceiling) |
| P7 | errors: distinct console fingerprints in >= 2 runs, client and server | negative | medium (new content ships bugs) |
| P8 | stalls: distinct 10-stud cells with runs/n >= 0.3 | negative | low-medium |
| P9 | shell size: buttons seen; abs change vs `v-1` as "shell changed" | covariate | high |

Composite friction index **F** = mean of z-scored P1, P2 (censoring imputed at max step), P5, P7 over the campaign;
equal weights, no fitting. Predictor reliability is measured first: the full lab twice on 3 versions (A/A), test-retest
per predictor; drop anything under 0.5 from F. Attenuation at true rho 0.5 with predictor reliability 0.5 / 0.7 /
0.9: observable rho 0.35 / 0.42 / 0.47 (predictor noise only); 0.32 / 0.37 / 0.42 if ΔD1 itself has reliability 0.8
(computed). Freeze the runner for the campaign (one `report.code` hash); a runner change means a full re-run.

### 6.4 Statistics honest at n = 30-60 (and at 155)

Two-sided alpha 0.05, Fisher-z approximation; sign test exact binomial (computed in the pairing plan).

| true rho | n=30 | n=45 | n=60 | n=100 | n=136 |
|---|---|---|---|---|---|
| 0.2 | 0.18 | 0.26 | 0.33 | 0.51 | 0.65 |
| 0.3 | 0.36 | 0.52 | 0.65 | 0.86 | 0.95 |
| 0.4 | 0.60 | 0.78 | 0.89 | 0.99 | 1.00 |
| 0.5 | 0.81 | 0.95 | 0.99 | 1.00 | 1.00 |

| K informative adjacent pairs | agreements needed (p < 0.05) | power at true agreement 0.60 / 0.65 / 0.70 / 0.75 |
|---|---|---|
| 20 | 15 | 0.13 / 0.25 / 0.42 / 0.62 |
| 30 | 21 | 0.18 / 0.36 / 0.59 / 0.80 |
| 45 | 30 | 0.22 / 0.48 / 0.75 / 0.92 |
| 60 | 39 | 0.26 / 0.56 / 0.84 / 0.97 |
| 100 | 61 | 0.46 / 0.83 / 0.98 / 1.00 |

Read against the expected rho 0.3-0.5: **n = 30 detects only rho >= 0.5; n = 60 detects 0.4 reliably and 0.3 two
times in three; the full history detects 0.3 at 0.95.** Get all the history, not a 30-60 sample. If the hand-coded
shell-only subset lands near 28 (the CSV pass) rather than 82 (the regex pass), the subset test detects only
rho >= 0.5 and is reported as exploratory.

Tests in order: (1) Spearman rho(**ΔF_v, ΔY1_v**) with a circular-shift permutation (10,000 shifts, preserves
autocorrelation in both series; both sides are first differences, so a persistent shell defect does not bias toward
the null); (2) adjacent-pair sign test over pairs with ΔF != 0; (3) null-consistency: over pairs with ΔF = 0 and
shell-size delta 0, ΔY1 must centre on 0 within the drift band, else de-confounding failed and nothing else is
interpreted; (4) ridge of ΔY1 on the standardized P deltas plus covariates, leave-one-out, pass statistic is
out-of-sample sign accuracy vs the permutation null; (5) secondaries Y2-Y5 against their named predictors, Holm
over four; (6) shell-only subset, only if >= 45 windows, else exploratory. Report every number with its n, Wilson
intervals on shares, bootstrap CI on rho only at n >= 30, and the test-retest table beside every rho.

### 6.5 Pre-registration (frozen before the join)

Freeze = this file's git commit plus sha256 of `lab-aggregate.mjs` and of the pairing script, in `prereg.json`,
before any outcome CSV is opened.

| Id | Hypothesis | Test | Pass | Fail |
|---|---|---|---|---|
| H1 (primary) | A rise in lab friction from v-1 to v predicts a fall in D1 | Spearman rho(ΔF, ΔY1), circular-shift permutation | rho <= -0.30 and p < 0.05 | rho > -0.15 or p >= 0.20 at n >= 60 (between: underpowered, extend n) |
| H2 | Direction agreement on informative adjacent pairs | exact sign test | k >= threshold in the table | below the 0.60-power expectation |
| H0c | No-change windows show no movement beyond drift | mean ΔY1 over ΔF = 0 pairs, t vs 0 | abs(mean) < 0.5 pp | else de-confounding invalid; H1-H2 not interpretable |
| H3 | Out-of-sample sign prediction beats chance | ridge LOO sign accuracy vs permutation null | p < 0.05 | otherwise |
| H4 | Shop reach predicts payer conversion | rho(ΔP4, ΔY4), Holm | rho <= -0.30, adj p < 0.05 | otherwise |
| H5 | Dead time predicts session length | rho(ΔP5, ΔY5), Holm | rho <= -0.30, adj p < 0.05 | otherwise |
| H6 | Shell-only subset shows stronger H1 | rho on subset vs all (only if subset >= 45) | abs(rho_subset) > abs(rho_all) | reported, not a fail of H1 |

Verdict rule: **the lab predicts real outcomes** if H0c passes and H1 passes and H2 or H3 passes. **Not this way** if
H0c passes and H1 fails at n >= 60 with predictor reliability >= 0.7. **Undecided** otherwise, with the reason named.
Everything not in the table is exploratory and labelled so. Shell/core hand-coding is done blind to outcomes, from
`bladeball_updates_all.csv` with its CCU columns removed, before the join.

### 6.6 Blind test protocol for each new update (starts with the first one)

1. Developer gives Parlay the candidate build (version number or `.rbxl`) before publish and nothing else.
2. Lab runs the frozen persona set on the candidate and on the live version, same day, alternated.
3. Parlay writes `prediction.json` `{version, F_candidate, F_live, predictedSignDeltaD1, pDown, top3Findings}`;
   `pDown` from the fitted relation, or 0.65 on the sign of ΔF alone before one exists (stated prior). Developer
   receives the sha256 before publish, the file after.
4. At publish + 5 days the developer sends the D1 series; Parlay scores directional hit and Brier `(pDown - [down])^2`.
5. Exact sign test on the running tally: K = 10 needs 9 hits, K = 12 needs 10, K = 15 needs 12, K = 20 needs 15.
   Brier against 0.25.
6. **Placebo arm**: for each real prediction, one for a random past week with no publish, live build run twice
   (ΔF should be ~0, prediction "no change"). A placebo hit rate near the real one means drift is being predicted,
   not the lab's signal.
7. Per-update report: sealed hash, prediction, outcome, running K/k, top-3 findings with developer confirmation.

### 6.7 Failure modes

| # | Failure | Evidence | Mitigation |
|---|---|---|---|
| 1 | Nearly every update ships core content the lab cannot see | 135/164 touch both (CSV pass) | blind hand-coding; core flag as covariate; claim only added signal, never explanation of D1 |
| 2 | Core balance (parry timing) drives churn | Blade Ball declared out of the runner's core reach (play-mode-research.md section 6) | same; H0c bounds the claim |
| 3 | Date-window attribution is approximate (server rollover, UTC days, multi-place) | documented: servers keep their version until restarted | deltas not levels; `rollover_guard` calibrated from `PeakConcurrentPlayers` by PlaceVersion; ask about Restart servers |
| 4 | No documented timestamp in Open Cloud version lists | assets v1.json and places.md schemas | deprecated develop.roblox.com route carries `created`; snapshot once; flag `version_time_estimated` if it breaks |
| 5 | Platform events and virality swamp weekly deltas | section 5 daily CCU | dated exclusion list before the join |
| 6 | Acquisition-source split exists only since 2025-10-16 | staff post | all-source D1 primary; source split as sensitivity |
| 7 | Funnel/economy/custom signals may not exist at all | A5 | `payer_cvr` and session buckets as stand-ins; ask for `customField1` release label going forward (careful of the 8,000-combination cap: one label per major release, not per version) |
| 8 | Old versions may not load, or load without DataStore-gated shell | `studioAccessToApisAllowed: false` | count and exclude with reason; 4b local file shows a no-profile shell |
| 9 | Predictor noise hides real rho | n = 10 runs gives +/-25-point intervals | A/A reliability first; drop < 0.5; raise runs if Studio time allows |
| 10 | Runner drift over a multi-week campaign | `report.code` exists for this | one hash per campaign |
| 11 | Reverse causation: shell fixes follow churn | plausible | adjacent pairs compare v to v-1; note fixes that follow visible drops |
| 12 | Live-ops changes with no publish | invisible in version history | A5 and A8 ask; flag windows |
| 13 | Fishing: 9 predictors x 5 outcomes x tests | arithmetic | one primary; Holm on four secondaries; freeze |
| 14 | Lab `placeVersion` reads 0 and pairs to nothing | recorded n=5 | out-of-band stamp (section 4 step 5, 7) |

---

## 7. What we can do before the data arrives

No Blade Ball access needed:

1. **Hand-code shell vs core** for all 164 updates, blind: copy `bladeball_updates_all.csv` with the four CCU
   columns removed, code each row `shell` / `core` / `both` plus a free-text note, and normalise the curated CSV's
   `lab_measurable` (17 free-text values today) to `yes` / `partial` / `no`.
2. **Runner additions** (small): `--place-version N` and an Edit-mode `game.PlaceVersion` read before
   `start_stop_play` in `qa/play.mjs`; write both into `report.json`; run folder named `bladeball-v<N>-<ts>`. Add
   `shop_reach_step` and `ftue_max_step` to `lab-aggregate.mjs` and move it into `qa/`.
3. **Live checks (a)-(e)** from section 4 on Dave's own published place: `EditPlaceRevision`, Edit-mode
   `PlaceVersion == N`, Play-mode 0, `EditFile` PlaceId 0, `HttpEnabled` write.
4. **A/A reliability run** of the full persona set twice on one lab place, to get a first test-retest table for
   P1-P9 and to catch predictors that never vary.
5. **`pull.mjs`** (stdlib Node, one file): loop over the section 3.2 query list, handle `202` polling, narrow the
   range on `429` code 3000, write one JSON per metric with `SHA256SUMS`. Give it to the developer with the key
   instructions. Plus a `version-fetch.mjs` for the develop.roblox.com route that takes a cookie from an environment
   variable and writes `version.csv` without contributors.
6. **Landing folder** `C:\bladeball-data\` on an encrypted volume; check BitLocker; copy the public Rolimons and
   wiki files into `raw\public\`; write `DELETE-BY.txt` when the agreement is signed.
7. **One-page data terms** from section 1.2, with the three lawyer items attached.
8. **Public exclusion list**: platform events, Winter Spotlight, The Hatch, The Hunt: Roblox 20 (2026-09-17..28),
   and any Roblox outage dates found in public status history, written before any outcome is seen.
9. **Send the intake** (section 1.1). Ask for A1 and A3 first: A3 loses data every week; A1 sets n.

Not built now: no dashboard, no statistics library, no analytics UI. The pairing script is one stdlib file written
after the first outcome CSV arrives and hashed into `prereg.json` before it runs on real outcomes.

---

## 8. Refuted or uncertain claims, kept visible

Claims from the research pass that a second reader checked against sources. The body of this document uses the
corrected version; the original is kept here so nobody re-derives it.

| Original claim | Status | What the sources actually say |
|---|---|---|
| "`game.PlaceVersion` is the shared key already captured by the lab" (schema join marked exact) | **refuted** | The field is captured (`probe.server.luau:8`, `play.mjs:293`) but reads 0 in every recorded Studio Play run (n=5, lab places only). Non-zero in Edit mode is community-reported (devforum 2025271). Version must be recorded out-of-band |
| "`/history` timestamp field name is unconfirmed" | **understated** | places.md documents no time field at all in the response; `published_at` has no documented Open Cloud source. The deprecated `develop.roblox.com/v2/assets/{id}/versions` documents `created` + `isPublished` |
| "Whether `AverageRevenuePerUser` is ARPDAU or per MAU is unknown" | **refuted** | metrics.md titles the row "Average revenue per DAU (ARPDAU)" |
| "Announcement example is crash rate by PlaceVersion" | **misattributed** | The staff announcement (devforum 4828676) uses DAU by IsNewUser; the crash example is on a community MCP page. The PlaceVersion-only-on-performance claim itself holds (metrics.md dimension rows) |
| "Analytics Query API is Beta; 30 POST/min, 3000 polls/min; empty days omitted; case-sensitive names" | **community-reported, not documented** | Official guide has none of these; source is devforum 4753664 (non-staff, 2026-07-23). Verify on first pull |
| "5 currencies" and a fixed `transactionType` enum | **docs conflict / wrong type** | economy-events.md says 5, event-types.md limits table says 10; `transactionType` is a free string bucketed to Other after 20 values |
| "Creator Hub charts show up to 2 years" | **contested** | Dashboard doc says any range from first available date; community says 2 years (Feb 2026) or 3 years (Jun 2026); API retention is 1468 days |
| "Open Cloud `ListAssetVersions` gives the version-date table" | **refuted** | AssetVersion schema has `path`, `creationContext`, `moderationResult`, `published`; no date |
| "Studio Version History widget can filter Published + date for the whole history" | **refuted for pre-2026 versions** | devforum 4451086: versions created before 27 Feb 2026 cannot be searched or filtered |
| "Wiki lists an update on 9 Aug 2026" | **refuted** | Scrape of 2026-09-21 ends at V14.7, 2026-07-11 |
| "`EditPlaceRevision` is immune to the Open Local Copy regressions" | **inferred, not documented** | CLI is documented; code-path independence is not. Aug 2026 hotfix was a flag picked up on restart |
| "Turn off Enable Studio Access to API Services for the session" | **refuted as advice** | It is a universe-level setting saved to the live configuration. Public flag is already `false`; use the local-file route for Play |
| "Edit access implies Save to File; owners cannot restrict it" | **community-reported** | devforum 2737283 replies, no staff or solution mark |
| "Unauthenticated assetdelivery probe returned 409" | **imprecise** | HTTP 200 with body error code 409 "User is not authorized to access Asset"; consistent with copylock, not the announced 401 auth wall |
| "Weekly (Saturday) log" | **partial** | 133/164 on Saturdays; 31 off-cycle |
| "Rolimons series is 6-hour resolution, 5,884 points" | **partial** | Mixed: 6 h to 2026-08-21, hourly to 2026-09-14, 10-minute from 2026-09-15; recent peaks are sampled 36x finer than older ones |
| "Nearly every update ships a paid Pack" | **overstated** | 86/164 sections name a Pack |
| "Only The Games shows a CCU lift; The Hunt and The Classic show none" | **refuted** | Daily series: Hunt First Edition ~2x on Mar 15-17 2024; The Classic ~1.8x May 23-28 2024; The Games no lift Aug 1-9; the Aug 10 100K peak is V5.0 Trading launch day |
| "Unexplained CCU spike 2026-09-18..20" | **explained** | The Hunt: Roblox 20, Sep 17-28 2026, Blade Ball participating (wiki event pages) |
| "Candidate n is ~136 windows" | **partial** | 136 is the count of gaps >= 6 days; the plan's own <= 2-day merge rule gives 155; ~10 recent unlogged windows are missing from both |
| "No Open Cloud analytics API (devforum 4739947)" | **outdated in the pairing plan** | The Analytics Query API exists (staff announcement 2026-08-24); 4739947 is a July 2026 feature request |
| "Whether the sales CSV carries a buyer id is unknown" | **refuted** | Documented column `Buyer User ID`; monthly files, 2-year cap. Not ingested |
| "Whether the shell loads in Studio with API access off is unknown" | **half-answered** | `studioAccessToApisAllowed: false` is a public fact for the universe; whether the shell renders without DataStores is still unknown |
| H1 as rho(F_v, ΔY1_v) | **mis-specified** | Level vs difference; a persistent defect biases toward the null. Corrected to rho(ΔF, ΔY1) |
| Attenuation 0.34 / 0.41 / 0.46 "from predictor reliability" | **arithmetic** | Predictor-only gives 0.35 / 0.42 / 0.47; the stated figures assume outcome reliability 0.95 |
| "A spender persona is required before P4 has variance" | **wrong for this game** | Coins come from the parry loop the lab cannot play; a Studio Robux prompt is a test purchase. P4 redefined as shop reach |
| Cookie Cats as "a single shell-type change" | **overgeneralised** | It is a progression-gate change; no public experiment on a lobby/menu/shop change was found. 0.5-2 pp stays an estimate |
| Shell/core split 82/79/1/2 | **unstable** | An independent pass on the same notes gives 28/135/1/0. Hand-code |
| "Primary outcome: Home-Recommendations D1 where available, all sources before" | **definition switch** | Breakdown exists only since 2025-10-16; two regimes with different variance. All-source D1 is primary |
| "Benchmark residual Y - Benchmark" | **undefined** | Benchmark is a 50th-90th percentile band across three sets; name the percentile; export unverified |
| "Y4 = new payers / new users from the sales CSV" | **not computable** | No first-play date in the sales CSV; requires user-level joins. Use economy events by IsNewUser or `payer_cvr` |
| ToU "updated 2026-09-04" | **metadata date** | Body says Effective Date May 19, 2026; Zendesk updated_at 2026-09-04 |
| "Aggregate metrics fit the permitted use" | **inference** | The Creator Terms grant a use right but do not define "User data" and have no vendor carve-out; lawyer item 1 |
| OAuth category "Analytics Insights Tools" | **misnamed** | "Analytics & Insights Tools"; scope added effective 2026-06-10; the App Terms' "Performance Data" clause was not surfaced (lawyer item 2) |
| Community Standards "prohibit sharing identifying information with other creators or third parties" | **misquoted** | Actual text: developers "may not share personally identifiable user engagement information with advertisers and must comply with the Creator Analytics Terms of Use and Roblox Terms of Use" |
| Privacy-notice sentence attributed to the App Policy; "collect no more than UserId, username" | **misattributed / not in text** | Privacy notice is in the App Terms (article 15887203369620); the Policy says "Users are only allowed to be identified by their user id" and bars combining Roblox data with off-platform data |
| "Publishing does not migrate running servers, overlap for hours" | **right claim, wrong citation** | Sources are the DataModel.PlaceVersion reference and projects/update-games "Restart servers"; overlap ranges from minutes to days depending on whether the developer restarts servers |
| "Studio Play runs can never contaminate the real side" | **scoped** | Verbatim true for AnalyticsService events; not established for the PlaceVersion performance series |
| `timeline\romonitor.html` cited as the id source | **dangling** | File does not exist; ids come from `timeline\game_details.json` |
| "`qa/lab-aggregate.mjs`" | **wrong path** | The aggregator lives in the job temp folder, not the repo |
| "We provide `pull.mjs`" | **not yet written** | Section 7 item 5 |
| Wiki quote "retains copies of all uploaded places" (help article 203313850) | **unverifiable here** | Article returns 403/challenge page to fetchers; no retention policy is documented on create.roblox.com |
| "Latest update 9 Aug 2026", "Sportskeeda lag 1-15 days" | **partial** | Try Hard Guides example is a 16-day lag; press dates are confirmation only |
| "`PluginManager():ExportPlace(path)` writes the place to disk" | **refuted (live, 2026-09-21)** | It is Studio's "Export Place" OBJ mesh export: the dialog offers "Object Model Files (*.obj)" and opens whatever path is passed; `pcall` returns ok and no file appears. No Luau API writes an `.rbxl` |
| "A 4a session reports `13772394625:N`" | **refuted (live, Aqua)** | `PlaceId 0`, `PlaceVersion 0`, `game.Name = "Place1 (Version N)"`; the bridge name carries no `(placeId: ...)`. Version provenance is the CLI argument plus the session name |
| Launch the Studio CLI with `spawn(..., { windowsHide: true })` | **bug (live)** | Studio honours the launcher's show flag: three invisible Studio processes ran for an hour. Spawn without it and close by pid |

Still open after all checks (needs the developer or a live call): timestamp field in `/history` items; whether Open Cloud
`asset-delivery-api` serves place versions; whether the shell renders with no DataStore; how many places the universe
has; whether Blade Ball logs funnels, economy or custom events at all; whether the studio restarts servers on
publish; the R15 conversion's actual status; the labels and dates of the ~10 updates since 2026-07-11.
