# Play mode: is the planner + reflex + referee loop possible for Roblox QA?

Written 2026-09-21 from ten research angles run in parallel (live Studio lab, spatial referee boundary, Claude
planner prototype, prior art, Jev steering battery, combat and catalogue, persona lab, Verifier, alternatives,
market), each followed by two adversarial reviews that re-ran or re-tallied the numbers. Starting points:
`docs/jev-research.md` (what Jev is) and `docs/jev-play-flow.md` (the proposed three-clock architecture).

Every number below carries its n and a file. `LAB` = `C:\Users\Dave.MAQUOKETA\.claude\jobs\260ad20a\tmp\playmode\`.
Revision 2 (2026-09-21) re-tallied every number a critic could not trace; its scripts and outputs are in
`LAB\doc-revision\` (`step-overhead.mjs/.json`, `placeversion-tally.mjs/.json`, `pricing.md`, `external-facts.md`,
`chrrxs-multiplayer-schema.txt`). Three labels recur: **transcript-copied** (numbers hand-copied from a workflow
transcript into a JSON file; no script on disk produced them), **external, not in LAB** (Roblox or vendor
documentation nobody saved to disk), **projected** (assumed token counts times list rates; the rates, assumptions
and arithmetic are in `LAB\doc-revision\pricing.md`).
Recorded runs R1, R2, R6 are the folders named in `jev-research.md` section 2 and 8. All Jev calls are pinned
`jev-1.13.0`. Studio bridge is Chrrxs 3.1.5 on the Aqua baseplate (place 88929721329145) unless a place id is given.

---

## 1. Verdict

**Possible, but not as drawn.** The planner (Claude, once per game version) and the referee (code) are necessary
and work. The per-tick Jev reflex is fashion: every steering decision Jev got right was a lookup over a boolean
code had already computed, and every one it got wrong was a threshold or a conjunction (the cases a steering loop
hits constantly). Movement, aiming, jumping and prompt-holding belong in Luau at Heartbeat rate; the Node tick
carries facts and interrupts, not verbs.

| Question | Answer | Evidence |
|---|---|---|
| Can the loop close on a real catalogue game? | Not yet shown on fresh profiles. On Play With Your Poop a hand-written code macro with no Jev (walk to line, hold 700 ms at the viewport centre, click ShopBtn then Tier2.Hit at y+58) got charge-and-throw **1/2 on fresh profiles** (run 1: hold sent, no charge, 0 coins after 41 s; run 2: pass, +3,124 coins in 3.2 s) and the 500-coin purchase **1/2 with coins >= 500** (run 2: 3,124 → 2,624; run 3 blocked because Solid was already owned, `Tier2.Hit.interactable=false`). Run 3 was not a fresh FTUE (2,624 coins at start, tutorial at 2/4, "HOLD ANYWHERE TO CHARGE" never shown, `walkToLine.holdTextSeen=false`), so its charge "pass" is vacuous: `poop-run.mjs:96` marks `text_gone` at tick 1 when the text is absent. `poop-run.mjs` has no profile reset; the 9.1 re-run with `ResetData` is the comparable number | `LAB\skeptic1-planner\poop-run.json` (3 runs, 2026-09-21 04:15Z), `poop-run.mjs` |
| Tick rate | Bridge floor 66 ms per client call, 17 ms server; four client calls share one 67 ms window; a code-only fact tick is 70-150 ms; adding Jev inline makes it 220-380 ms; today's runner spends a median 640-670 ms per step outside the key hold and the 500 ms pace (n=7; 22) | `LAB\liveLab\results.json`, `LAB\referee-boundary\timing.json`, `LAB\combat\tick-floor.json`, `LAB\doc-revision\step-overhead.json` |
| Reflex timing | Aim must be computed on the frame of the click (10/10 hits vs 1/10 from a 300 ms-old position); a 7-stud jump has a 105 ms window, an 8-stud one 44 ms; only Luau at Heartbeat reaches that | `LAB\combat\play-probe-1789962455661.json`, `play-probe-1789962562980.json` |
| Cost | Jev at 3 Hz would be $0.29-0.71 per hour of play (10,800 calls x 650-1,555 tokens x $0.042/M); the shipped one-call-per-action loop measured $0.043/h (R6: 14 calls, 17,574 tokens, 61.9 s), so the flow doc's $0.05 holds for the shipped loop and not for a 3 Hz reflex. A Claude plan is $1.46 (n=1, Fable 5.1 list, measured); a `--resume` re-plan $0.36-0.43 warm (n=3, median $0.40), $1.16 cold (n=1); triage $0.35-0.60 per run is an estimate (token arithmetic at Opus 5 rates, `total_cost_usd` unrecorded) and would dominate any lab; a code-only tick is $0 | `docs/jev-research.md:44`, `LAB\skeptic2-pa2\r6-call-audit.json`, `LAB\claude-planner\run.json`, `LAB\skeptic2-p4\results.json`, `LAB\skeptic-p4\resume-results.json`, `LAB\doc-revision\pricing.md` |
| Coverage | 45 of the top 100 games (60.5% of CCU) need only UI, walk-to and prompts; 26 (20.7%) need code aim and threat bearing; 8 (4.9%) need a sub-150 ms code trigger; 21 (13.9%) need opponents, vehicles or ball timing. Pathfinding fails on the real obby beyond 80 studs (n=7, transcript-copied) | `LAB\combat\top100-classified.csv` (shares recomputed 2026-09-21), `LAB\referee-boundary\studio-edit-probes.json` |
| Where Jev is necessary | Nowhere proven. Where it is plausibly useful: mapping a brief's intent to a distinct on-screen label (12/12 non-default picks at 0.66-0.95), the newbie's `lost`/`suggests` over free text. Where it is fashion: choosing among code-vetted candidates (first-listed wins 9/9 with no brief; R6's Jev pick agreed with the scripted pick 4/4 on multi-option steps, and 10/14 of its calls had a single option), any per-tick verb, any comparison. "Nowhere proven" is a carried null, not a result: no paired code-vs-Jev run exists, and the A/B in 9.2 step 1 is the first thing that could overturn it | `LAB\alternatives\results.jsonl`, `LAB\skeptic2-pa2\r6-call-audit.json`, `LAB\skeptic-s2\tables.md` |

Two runner bugs came out, both in the action layer and independent of Jev: Chrrxs pixel clicks land 58 px above
their GUI target (probe y is GuiInset-relative; raw clicks 0/4, +58 clicks 3/3 in the lab; on Poop the ShopBtn raw
0/3, +58 3/3), and a ClickDetector never fires on the first virtual contact at a new position (0/4 first contacts,
hover only; 2/2 once the part is already hovered).

What we could not establish: a live Jev-in-the-loop closed run (no angle ran one); the planner + code loop on a
fresh Poop profile (no recorded run had `ResetData`); the obby Pathfinding and instance-scan numbers from a script
on disk (transcript-copied today); probe cost on a 50k-instance place; run-to-run variance of a Claude plan (n=1); whether a code coverage policy loses anything to Jev on a
navigation-heavy place (the planted place does not exist yet); the built-in Studio MCP's hold behaviour across
two calls; the cause of one silent no-charge hold (1/3) and one mid-session bridge death (1/3).

---

## 2. What the live lab measured

Three angles drove Studio through Chrrxs (liveLab two sessions 76 s of Play; referee-boundary; combat three
sessions; skeptic1-planner three Poop runs). Every place was left in Edit with an empty ServerScriptService.

### 2.1 Bridge and model latency

| Call | min / p50 / p90 ms | n | File |
|---|---|---|---|
| `eval_client_runtime`, 5-line probe | 65 / 67 / 68 | 20 | `LAB\liveLab\results.json` latency |
| `eval_client_runtime`, full `probe.client.luau` | 50 / 66 / 67 | 8 | same, probeCost |
| `eval_client_runtime`, rich probe (8 raycasts + Humanoid scan, 322 descendants, Luau 0.1 ms) | 65 / 66 / 67 | 10 | same |
| `eval_client_runtime`, `return "1"` | 44 / 49 / 50 | 10 | `results2.json` concurrency |
| `eval_server_runtime`, 5-line probe | 14 / 17 / 18 | 20 | results.json |
| `execute_luau` edit `return 1` | 4 / 17 / 18 (max 552) | 20 | `LAB\combat\tick-floor.json` |
| `get_runtime_logs` | 65 / 66 / 67 | 20 | results.json |
| key press / release | 65 / 66 / 67 ; 65 / 66 / 68 | 10 each | results.json |
| key tap, plugin default 0.1 s hold | 165 / 167 / 183 | 20 | results.json |
| key tap, duration 0.02 | 99 / 100 / 101 | 8 | results2.json |
| mouse click | p50 117 | 5 | `LAB\referee-boundary\timing.json` |
| client + server probe in parallel | 33 / 66 / 67 | 10 | results2.json |
| 4 client probes in parallel | 64 / 67 / 67 | 5 | results2.json |
| 8 client probes in parallel | 132 / 133 / 133 (two quanta) | 3 | results2.json |
| client + server + press + release in parallel | 66 / 67 / 67 | 5 | results2.json |
| `capture_screenshot` png 2852x899, 676 KB | 1059 / 1347 / 1368 | 20 | results.json |
| `capture_screenshot` jpeg q60 120 KB / q30 91 KB | 1029 / 1159 p50 | 3 each | results2.json |
| Jev, 5 questions per POST | 103 / 149 / 196 (max 321) | 198 | `LAB\jevSteer\tables.md` |
| Jev, 1-2 questions | 103 / 145 / 193 (max 302) | 84 | `LAB\referee-boundary\steer-table.md` |
| Jev, runner shape | 98 / 145 / 240 (max 380) | 116 | `docs/jev-research.md` D15 |
| client→server replication of a MoveTo | client sees >1 stud at 66-67 ms; server at 261 / 328 / 316 ms | 3 | timing.json replication |
| Play start / character ready | 2355 and 2365 ms / 259 and 9 ms | 2 | results.json play |

### 2.2 What the runner spends today

Tally script `LAB\doc-revision\step-overhead.mjs` → `step-overhead.json`. Definitions: gap = `t(step i+1) − t(step i)`
from `report.json actions[].t`, attributed to step i; overhead = gap − key-hold ms (walk steps hold the key for
`action.ms` inside `act()`) − 500 ms pace (`play.mjs --pace-ms` default; report.json does not record pace, so 500 is
an assumption).

| Measure | Value | n | File |
|---|---|---|---|
| Runner overhead per step (5-6 bridge calls + Jev), empty baseplate, all walk steps | median 670 ms (qa-live-2); 640 ms (qa-live-4) | 22; 7 | `step-overhead.json` qa-live-2, qa-live-4 |
| Same overhead on Poop, click steps (no key hold) | median 962 ms (R1), 1,298 ms (R2), 455 ms (R6, after the interactable/inWindow filter) | 14; 26; 7 | same, R1 / R2 / R6 |
| Gap after a click step on Poop, incl. pace | median 1,462 ms (R1), 1,798 ms (R2), 955 ms (R6) | 14; 26; 7 | same |
| Gap before a click step on Poop (the other attribution) | median 1.96 s (R1), 1.82 s (R2) | 14; 26 | `LAB\verifier\determinism.out.txt:25-28` |
| Gap over every step on Poop | median 2,604 ms (R1), 1,834 ms (R2) | 39; 33 | `step-overhead.json` (the first draft mislabelled these n as click-step gaps) |
| R6 click steps / walk steps | 934-992 ms / 2587-3856 ms | 7; 6 | `LAB\skeptic2-pa2\r6-call-audit.json` |
| Whole run | R2 34 steps / 72.5 s = 2.13 s per step | 1 | jev-research 2 |

### 2.3 Spatial primitives, all reachable from code

| Primitive | Result | n | File |
|---|---|---|---|
| Held key between calls | W pressed, no calls between: 20.3 studs/s (434-800 ms), 15.5 (800-1183 ms), 4.0 studs coast after release | 1 run, 3 legs | `LAB\liveLab\results.json` held |
| Turning | Left/Right arrow 500 ms: camera yaw +64.9 / -65.1 deg, character 0 deg, moved 0. A/D 500 ms: 8.97 / 9.1 studs sideways, character heading swings 154-178 deg, camera 0 | 1 each | results.json turning |
| Pathfinding around a 30x12 wall to a target 60 studs away, client ComputeAsync + MoveTo | Success in 147 ms, 21 waypoints, MoveToFinished 21/21, arrived 4781 ms, final 2.7 studs | 1 | results.json pathfinding |
| Pathfinding, empty place, client | Success, 12 waypoints, 132 ms compute, 207 ms round trip | 1 | timing.json clientPath |
| Pathfinding on the real obby (76846718367805) from spawn | 17 / 44 / 80 studs Success (97 / 83 / 101 ms); 150 / 300 / 634 studs NoPath (~100 ms); 3369 studs "path request is too long" | 7 | `LAB\referee-boundary\studio-edit-probes.json` (**transcript-copied**: the file's own note says the Luau exists only in the workflow transcript; no script on disk produced it) |
| 3D aim, same frame: WorldToViewportPoint + SendMousePosition + SendMouseButton on a 4-stud cube at 30 studs | 10/10 at 16 studs/s; 10/10 at 24 studs/s | 20 | `LAB\combat\play-probe-1789962455661.json` moving |
| Same aim from a position 300 ms old / 600 ms old | 1/10, 1/10 / 2/10 | 30 | same |
| `VirtualInput` from `eval_client_runtime` identity | CreateVirtualInput ok 3/3 sessions; SendKey, SendMouseButton, SendMousePosition, SendMouseDelta, SendPointerAction, SendTextInput all present; Mouse.Target on target 3/3 | 3 | `LAB\combat\play-probe*.json` aim |
| Camera write `CurrentCamera.CFrame = lookAt` under Custom / Scriptable | survives 3/3 and 3/3; centre ray hits 2/3 | 3 | same |
| Jump by `Humanoid.Jump = true` from an eval | 0/8 (ControlModule rewrites it every RenderStepped) | 8 | play-probe.json, play-probe-1789962455661.json gap |
| Jump by Heartbeat edge raycast + `Humanoid:ChangeState(Jumping)` | landed 3/3 at gaps 5 / 7 / 8; trigger repeatable to 1e-7 studs; apex 7.24-7.31 | 3 | play-probe-1789962562980.json gap |
| Jump window at defaults (JumpHeight 7.2, WalkSpeed 16): gap 7 / gap 8 | ~105 ms / ~44 ms; one 300 ms tick = 4.8 studs | arithmetic | same |
| GuiInset | (0, 58); AbsolutePosition is inset-relative for IgnoreGuiInset true and false; raw clicks 0/4, +58 clicks 3/3 | 7 | results.json aim, results2.json gui |
| GuiInset on Poop | ShopBtn raw click opened the shop 0/3, +58 click 3/3 | 3 | `LAB\skeptic1-planner\poop-run.json` |
| ClickDetector | first contact at a new position (click x2, down/80 ms/up x1, click after moving away x1): 0/4 fire, hover only; click while already hovered: 2/2 fire | 6 | results2.json clickDetector (LabA/B/C) |
| GUI button | fires on the first click at the right pixel 3/3 | 3 | same |
| Hold through Chrrxs (mouseDown call, sleep, mouseUp call) | one InputObject 4/4; held 762-766 ms for 700 requested (+the down call's 63-67 ms) | 4 | `LAB\skeptic1-planner\hold-probe.json` |
| Hold through the built-in MCP in one call `[mouseButtonDown, wait 700, mouseButtonUp]` | same InputObject, 999 ms held, threw (+1461 Coins) | 1 | `LAB\skeptic1-planner\builtin-probe.json` |
| Hotbar equip by key "One" | Chrrxs tap: 0/3 on Poop (Poop Seat in Backpack, `poop-run.json` keyOne) and 0/1 on Aqua with an inserted LabTool (`hold-probe.mjs:117-121`, `hold-probe.json`); built-in refuses: "key is permanently bound to a CoreGUI core action"; pixel click on the hotbar refused: "hits CoreGUI"; `Humanoid:EquipTool` 1/1 | 4; 1; 1; 1 | `LAB\skeptic1-planner\` |
| Bridge stability | 1 mid-session "fetch failed" in 3 combat sessions (~7 min); R1 died the same way at step 40 | — | play-probe-1789962562980.json |

### 2.4 What it means for the tick

- One tick can issue the client probe, the server probe, the log read and the pending input in one ~67 ms window.
  A code-only fact-and-interrupt tick is therefore 70-150 ms. This is the referee's clock.
- Jev inline adds 145-149 ms p50 (196 p90, 321 max): 220-300 ms with parallel probes, ~380 sequential. The
  300 ms tick in `jev-play-flow.md` is reachable only by re-shaping the runner to one window per tick and moving
  Jev off the critical path; today's 5-6 sequential calls cap out near 1.5 Hz at pace 0.
- Aim and jump windows (44-105 ms) are below any bridge tick. Those reflexes run in Luau at Heartbeat (16.7 ms)
  inside a persistent client task (`_G` persists across evals: `results.json play.gPersists`).
- Screenshots (1.0-1.4 s regardless of format) never sit inside the tick; take one when a note fires, after the
  fact, and capture before `act()` so the picture matches the judged step (`jev-research.md` 2.2).
- Position, heading, raycasts and camera must be read on the client (the server view lags 200-330 ms, about one
  tick); stats, leaderstats and far targets on the server (17 ms).

---

## 3. The architecture decision

### 3.1 Where movement lives: code navigates

| Option | Evidence | Decision |
|---|---|---|
| A: Jev picks turn/step/jump every tick | Raw numeric facts: 21/30 (referee-boundary), 43/66 (jevSteer bare), 9/15 (alternatives A-num); with code-computed labels 30/30, 66/66, 15/15, i.e. Jev reads back a boolean code already holds. At thresholds named criteria fail on conjunctions 0/6 (`LAB\skeptic2-S2\boundary3.log`) and 9/21 (`LAB\skeptic-s2\tables.md`). Turn verbs have no clean actuator (arrows turn the camera, A/D strafe). A 300 ms tick moves 4.8 studs blind | **Rejected** |
| B: code macro, `goto(target)` = PathfindingService once per target + `Humanoid:MoveTo` per waypoint, `ChangeState(Jumping)` on Jump waypoints, recompute on `Path.Blocked`, unreachable on NoPath or one `MoveToFinished(false)`; straight MoveTo (the shipped `play.mjs:59-68`) as fallback | 21/21 waypoints around a wall in 4.8 s (n=1); obby Success to 80 studs, NoPath beyond (n=7, transcript-copied); prior art: every compared system put locomotion in code (GITM 67.5% vs learned 20%/0.6%; DEPS 60% oracle vs 0.6% learned) | **Adopted** |
| C: B plus Jev takes over in reactive situations | flee/fight were code-decidable once lowHealth/inReach were facts (3/3 coded vs 0/3 raw); the useful residue is code interrupts that end a macro early | **Collapsed into B**: interrupts are code |
| Teleport (`root.CFrame = target`) for personas not testing traversal | 1 line, 0 s, replicates (client owns its character); hides traversal bugs | Allowed as a mode for ui/breaker on UI-only games; never for explorer/newbie |

Mode mapping from the reviews (`LAB\skeptic2-r1\reach.mjs`, written, not run): a 90-trial moveto vs path vs
teleport comparison over 3 places decides whether Pathfinding earns its 40 lines over the shipped straight MoveTo.
Until then straight MoveTo stays and Pathfinding is the fallback on "gave up"/"timeout".

### 3.2 Where aiming lives: Luau, same frame as the click

Aim = `camera:WorldToViewportPoint(target)` then `VirtualInput:SendMousePosition` and `SendMouseButton`, or a
one-off `Camera.CFrame = lookAt` for centre-screen weapons, all inside one client eval on the frame of the shot
(10/10 vs 1/10 for a 300 ms-old aim). First-person `SendMouseDelta` works only when the lock is re-asserted after
the camera render step (158.7 deg per 10x40 px, n=1) and errors "cursor is not locked" otherwise (2/2). The Chrrxs
plugin comment "there is NO SendMouseMove" is stale: `CreateVirtualInput()` from the eval identity exposes it.

### 3.3 What is left to decide each tick, and by whom

| Owner | Every tick (70-150 ms) | On event (macro ended, interrupt, new panel) | Once per game version |
|---|---|---|---|
| Code | probes in one window; deltas; `done` before `fail` per subgoal; interrupts (health drop >=10, Dead/Seated/Ragdoll/Freefall >1 s, position jump >50 studs, PromptShown, MoveToFinished false, new fingerprint); exploit gate; stuck; dead-button bit (`lastClicked.interactable && delta empty`); GuiInset on every click y | pick when 0 or 1 admissible candidate (R6: 10/14 calls were single-option); `prefer` resolves to one visible+enabled button in 4/7 Poop subgoals | — |
| Jev (async, never gating the tick) | free-text nouls only: `lost`, `suggests`, `looksWrong` stripped of code-shaped clauses | choice among <=7 distinct code-vetted candidates **only when a brief or persona is set and 2+ remain**; recorded log-only alongside the code pick until the A/B in section 9 says it earns its call | — |
| Claude | — | re-plan on fail leaf, budget, or a new panel with >=3 buttons no glob matches (fresh stripped call, ~$0.20) | plan: subgoals with `done[]`/`fail[]` leaves, `prefer`/`avoid` paths, `actions_needed`, budget; triage once per lab |

### 3.4 Revised flowchart

```mermaid
flowchart TD
  Dev[Developer: Quality Assurance tab<br/>place · persona · brief] --> Plan

  subgraph Plan["PLANNER · Claude · once per (mirror hash, brief); re-plan on code events (~$0.2-1.5)"]
    P1["reads: brief, first probe, script tree,<br/>grep hints, seen GUI paths"] --> P2["subgoals: done leaves ANDed · fail leaves ORed<br/>over probe facts · prefer/avoid paths ·<br/>actions_needed · budget_steps"]
  end

  Plan -->|plan.json, cached| Loop

  subgraph Loop["LOOP · code-owned · one bridge window per tick (70-150 ms)"]
    L1["PROBE in parallel: client (position, camera yaw,<br/>rays, prompts shown, buttons + inset, text)<br/>+ server (stats, health, far targets) + logs"] --> L2["REFEREE code: deltas · done before fail ·<br/>interrupts · exploit gate · stuck · dead-button bit"]
    L2 -->|macro still running| L1
    L2 -->|macro ended or interrupt| L3{admissible<br/>candidates}
    L3 -->|0 or 1, or no brief| L4[code picks:<br/>untried-first · prefer · nearest]
    L3 -->|2+ and brief/persona| L5[Jev choice among ≤7 distinct options<br/>+ free-text nouls · async · log-only until proven]
    L4 --> L6["MACRO in Luau at Heartbeat:<br/>goto (Pathfinding + MoveTo) · click y+inset ·<br/>hold · prompt hold · equip · aim on the frame · edge-jump"]
    L5 --> L6
    L6 --> L1
  end

  Loop -->|fail leaf · budget · unmatched new panel| Plan
  Loop -->|done · exhausted · cap| Triage

  subgraph Triage["TRIAGE · Claude · once per lab over the union of keys"]
    R1[errors, dead controls, exploits,<br/>stalls, lost + scripts + one pre-act screenshot] --> R2[bug / look / fine · file:line]
  end

  Triage --> Fix[Fix with Claude at file:line]
  Fix --> Verify[VERIFIER · code only · replay by intent ×3<br/>verdict: fingerprint gone / delta non-empty]
  Verify --> Report

  subgraph Lab["LAB · CLI loop · K Studio windows on K place copies"]
    L7[newbie ×20 · ui ×10 · explorer ×10 · breaker ×10 · spender ×10]
  end
  Lab --> Report[per (persona, key): runs flagged / n with Wilson interval ·<br/>stalls · dead controls · crashes · first earn / first spend]
```

Changes from `jev-play-flow.md`: the REFLEX box is gone (verbs are Luau macros); Jev is an event-driven, async,
brief-conditioned chooser plus free-text judge, not a per-tick decider; the planner is cached and re-planned by
fresh stripped calls, not `--resume`; triage runs once per lab; the Verifier is code.

---

## 4. The planner

### 4.1 What was run

One headless call on the Play With Your Poop mirror (`claude -p --json-schema`, tools Read/Grep/Glob, effort
medium, cwd = the Script Sync mirror), brief "do the tutorial, then buy the cheapest item".

| Measure | Value | File |
|---|---|---|
| Wall / API / turns | 144 s / 140 s / 14 | `LAB\claude-planner\run.json` |
| Cost (Fable 5.1 list) | $1.46 = cache write 66,410 tok ($0.83) + output 11,457 ($0.57) + cache read 231,781 ($0.06) | run.json |
| Prompt | 25,270 chars (~6.3k tok): 150-script name tree, first observation, vocabulary, 13 grep hints | `prompt.txt` |
| Reads | ~520 lines over 10 Read/Grep calls; never opened the 343 KB Config.luau wholesale; declined the offered screenshot | `plan.json` reads, screenshot |
| Output | 7 subgoals, 29 predicate leaves, 6 honest unknowns | `plan.json` |
| Fixed base of a fresh `claude -p` in that cwd | 33,701 tok with the default system prompt; 7,228 with `--strict-mcp-config --mcp-config empty.json --system-prompt <one line>` ($0.11 whole cold call) | `LAB\skeptic2-p4\base-results.json` |

### 4.2 Predicate vocabulary (15 ops, flat schema, no $ref)

`visible, enabled, clicked, text, text_gone, stat, stat_delta, health, state, near, moved, console, place_changed,
steps, luau`. Used by the prototype plan: text_gone 7, steps 7, health 5, stat_delta 3, text 3, console 2, stat 1,
place_changed 1; the 7 path ops were never exercised (`check-results.json` ops_used). Plan schema per subgoal:
`{id, title, why, done[] (ANDed), fail[] (ORed), budget_steps, prefer[], avoid[], walks, interactables, jev_brief
<=120 chars of on-screen words, actions_needed}` plus top-level `game, ftue, cheapest_item, replan_on, unknowns,
screenshot, reads` (`plan.schema.json`).

### 4.3 The prototype plan and whether its predicates were code-checkable

| Subgoal | done | fail | budget | actions_needed | Checkable? |
|---|---|---|---|---|---|
| walk-to-line | text_gone "STEP UP TO THE LINE" | steps>=60 OR health<=0 | 60 | walk | Lint-clean, but wrong under start-snapshot semantics: Steps[1] "ONE HOLY POOP" is on screen for the first 3.5 s (Config.luau:2045-2075), so the text is never in the snapshot and `text_gone` never fires |
| charge-and-throw | text_gone "HOLD ANYWHERE TO CHARGE" AND Coins delta >= 500 | steps>=150 OR health<=0 | 150 | hold_release, wait | Correct; needs a verb the loop lacked. Live with a code hold on fresh profiles: 1/2 (`poop-run.json` runs 1-2; run 3 was not fresh and its pass is vacuous, section 1) |
| train-poop-seat | text "BUY THE SOLID POOP" | steps>=120 OR health<=0 | 120 | click, walk, prompt | Correct; equip needs `Humanoid:EquipTool`, not a key |
| buy-solid | Coins delta <= -500 AND text "NOW CLOSE THE SHOP" | steps>=60 OR Coins < 500 | 60 | click | Correct only if done is evaluated before fail (fail is true on the tick done becomes true). Live with coins >= 500: 1/2 (run 2 pass 3,124 → 2,624; run 3 blocked by ownership, `Tier2.Hit.interactable=false`) |
| close-shop | text_gone "NOW CLOSE THE SHOP" | steps>=30 | 30 | click | Correct |
| rebirth-signpost | text_gone "REBIRTH: YOUR NEXT GOAL" | steps>=50 | 50 | click, wait | Correct; its `prefer` names a panel (StudRebirthPanel) that never appeared in any recording |
| practice-throw-finish | text_gone "Skip" | steps>=200 OR health<=0 | 200 | walk, hold_release, wait | False positive: Skip sits at y=-24 (`inWindow=false`) and the agent filter drops it, so over the filtered list "Skip" reads as gone at step 1 while the tutorial is running |

Offline check (`check-plan.mjs`, `check-results.json`): 29/29 leaves lint-clean and evaluable, 0 Luau,
`done_true_at_spawn` 0, `fail_true_when_done_true` 1 (buy-solid), 3/7 subgoals need `hold_release`/`wait`,
5/7 `jev_brief`s contain words never on screen, 8/31 prefer/avoid globs match no recorded path (all from Fusion
panel depth: Claude wrote `App.PanelLayer.StudShopPanel.*.Tier2.Hit`, the real path is
`App.Hud.PanelLayer.Shop.StudShopPanel.Panel.ScrollingFrame.Tier2.Hit`). Facts about the game were right: 13 FTUE
steps in order, Solid at 500 Coins, `Net.TutorialDone`, Skip button path.

### 4.4 Contract corrections from the reviews

| Defect | Fix |
|---|---|
| `text_gone` against a start snapshot misses text that appears after the subgoal starts | Evaluate against the set of every text seen since the subgoal's first tick (plan-level set for `replan_on`); the snapshot is for `stat_delta` and `moved` only |
| `console` reads only the current tick's last 5 lines | Accumulate matched lines per subgoal |
| Leaves evaluated over the agent-filtered button list read off-window buttons as gone | Evaluate every leaf over the raw probe (`raw.client`), never the filtered list |
| `fail` true on the same tick as `done` | Evaluate `done` before `fail`, every tick; lint rejects a plan whose `fail` is true on an observation where `done` is true |
| Path globs cannot know Fusion depth; last-2-segment suffix matching recovers 30/31 but 3 of those hit the wrong panel's CloseButton (`LAB\skeptic-p2\retally.mjs`) | Segment-subsequence match: named segments in order, any gap, leaf anchored (`(^|\.)A(\.[^.]+)*\.B$`); lint refuses a pattern with no literal non-leaf segment. Against R2's 34 paths: 31/31 intended, 0 wrong (`LAB\skeptic-p2\match-compare.json`). Hand the planner a one-shot unfiltered `PlayerGui:GetDescendants()` GuiButton dump at plan time (all five Poop panels mount at spawn behind a Visible latch) |
| `game.PlaceVersion` is 0 in every recorded Studio Play run that carries the field: R1, R2, R6 on Poop (124502189011089) and qa-live-2, qa-live-4 on Aqua (88929721329145), n=5 runs with steps; one earlier 13-step run predates the field (`LAB\doc-revision\placeversion-tally.json`) | Cache key = sha256 of the Script Sync mirror's `.luau` + brief + prompt-template hash |
| `--resume` re-plans: warm $0.36-0.43 (n=3, median $0.40), cold $1.16 (n=1), wall 46-70 s, output 4-6.6k tok is 55-75% of cost; TTL is 5 min and only Claude calls refresh it; two runs resuming one session interleave transcripts | Fresh stripped `claude -p` (7.2k base measured; $0.11 for a noop plan) with plan.json + failed subgoal + last 20 stepsLog lines + gui.seen, patch schema (changed subgoals only): **projected** ~$0.20 cold, ~$0.06 warm at ~13k tokens in and <=800 out (`LAB\doc-revision\pricing.md` section 3); no session file |
| `hold_release` and `wait` not in `act()` | Add `hold {x,y | path, ms}` (built-in: one call `[mouseButtonDown, wait, mouseButtonUp]`; Chrrxs: two calls with mouseUp in a `finally` and a "down with no up for >3 s" safety); `equip {toolName}` via `Humanoid:EquipTool`; drop `key` for hotbar (CoreGui-bound keys are refused by both bridges) |
| Re-plan on "actions_needed not implemented" | Refuse at plan load instead ($0); `check-plan.mjs` already computes it |
| Re-plan calls `Humanoid.Jump = true` | Never; `ChangeState(Jumping)` |

### 4.5 Context selection and re-plan signals

Context that worked: script name tree minus Packages (~2.5k tok), first-tick observation (~1k), vocabulary and
rules (~2k), a deterministic grep of on-screen strings over the mirror (13 hints; "STEP UP TO THE LINE" pointed at
Config.luau:2073 in one hop). Vision was offered and declined; everything visible on Poop is TextLabel text the
probe exports. Re-plan signals are code events: a fail leaf, budget exhausted, a new panel with >=3 buttons no
glob matches, `replan_on` leaves (place_changed, health<=0, FTUE ended). Cost per session with one cached plan and
0-2 re-plans: $0-0.40 on top of triage.

Not established: planner quality on other models (Opus 5 ~$0.82, Sonnet 5 ~$0.33, Haiku 4.5 ~$0.16 **projected** at
the same token counts, `LAB\doc-revision\pricing.md` section 2; quality n=0), other games (n=1), run-to-run plan variance (n=1), a live execution of the full plan through a
subgoal machine (none exists in `play.mjs`; the three Poop runs used a hand-written macro sequence).

---

## 5. Can Jev steer?

### 5.1 Fine verbs from spatial facts (7 verbs: turn L/R, step forward/back, jump forward, plus attack/use in some batteries)

| Battery | Encoding | Criteria | Correct | n | File |
|---|---|---|---|---|---|
| jevSteer, 40 synthetic situations, 3 encodings | raw numbers | bare verbs, rule in the instruction | 43/66 = 65% | 66 | `LAB\jevSteer\tables.md` |
| | relative prose | bare | 57/66 = 86% | 66 | |
| | boolean facts | bare | 35/66 = 53% (turn_left 0/18: "clearAhead: yes" pulls Step forward) | 66 | |
| | raw numbers | named (option text states field and threshold) | 66/66 = 100% | 66 | |
| | relative | named | 65/66 = 98% | 66 | |
| | facts | named | 66/66 = 100%; margin 0.87; a goal sentence flipped 6/66 to wrong | 66 | |
| | any | 2-option turn/step | raw 74%, relative 90%, facts 42% | 50 | |
| referee-boundary, 10 cases | raw | thresholds in instruction | 21/30 (behind 0/3, wall 0/3, flee 0/3) | 30 | `LAB\referee-boundary\steer-table.md` |
| | code labels (where/inReach/blocked/lowHealth) | rule spelled out | 30/30, margin 0.86 (behind 0.07: a correct L/R tie) | 30 | |
| | fine 14 verbs vs coarse 6 | coded | family 15/15 both; pTop 0.98 → 0.72, margin 0.97 → 0.55 | 30 | `steer-table2.md` |
| alternatives, 5 cases | numeric bearing/distance | rule in instruction | 9/15 (+40 deg → step_forward 3/3; distance 4 <= 8 → use_prompt 0.06) | 15 | `LAB\alternatives\probe-alternatives.log` |
| | code words (side, inRange, blockedAhead) | | 15/15 at 0.85-1.00 | 15 | |
| Boundary probes, raw, named | within 1-5 units of a threshold | | 0/2 (n=1 each); 9/21 (7 cases x 3: conjunctions 0/12, single thresholds 9/9) | 23 | `LAB\jevSteer\boundary.jsonl`, `LAB\skeptic-s2\tables.md` |
| Boundary probes, ±1 of each threshold | raw named | | 21/27 (single-number rules 15/15; two-condition retreat 0/6 at p 0.90-0.98) | 27 | `LAB\skeptic2-S2\boundary3.log` |
| | facts named | | 27/27 | 27 | |
| Threat noul (<=10 vs 40+ studs) | any | named | AUROC 1.000, repeat sd <=0.003; undefined in the 11-39 gap (0.35-0.45 at 11-12 studs) | 66 per encoding | tables.md, boundary3 |

Reading: "named" 100% means the option text restates the referee rule and Jev echoes a boolean code already
computed; the generators kept every situation 5-8 units from every threshold. At the thresholds the conjunction
rule fails confidently. Latency 145-149 ms p50; cost $0.000054 per call at 1,280 tokens.

### 5.2 Choosing among candidates (the layer the play-flow doc would keep)

| Probe | Result | n | File |
|---|---|---|---|
| No task, 7 distinct buttons, three list orders | first-listed wins every time: Shop 0.96-0.97, Inventory 0.92-0.95, X 0.87-0.90 | 9 | `LAB\alternatives\results.jsonl` B-ctl/B-order/B-order-Xfirst |
| Same, every option text names its (shared) fact | first-listed 9/9 at 0.90-0.97 | 9 | `LAB\skeptic-s2\tables.md` section 2 |
| R6 live run, multi-option steps | Jev's pick = the scripted policy's lowest-index untried pick 4/4; 10/14 calls had one option | 14 | `LAB\skeptic2-pa2\r6-call-audit.json` |
| R2, multi-click steps | lowest-index untried chosen 16/25 | 25 | jev-research 2.3 |
| Intent brief, no shared word: "redeem a promo code" → Codes, "equip something I own" → Inventory, "turn the music off" → Settings, "collect the daily reward" → Claim | 12/12 at 0.66-0.95 | 12 | alternatives B |
| "buy a sword" with Shop listed last | Shop 3/3 at 0.52-0.54 (vs 0.98 listed first) | 3 | alternatives B-order |
| Same intent on game idiom ("buy the cheapest poop" vs "Hit in Tier1") | 0.02-0.07 (P8) | 3 | jev-research P8 |
| Poop plan briefs: charge screen with `hold` on the menu | hold 6/6 at p 1.00 under two wordings; shop screen: ShopBtn 6/6 instead of Tier2.Hit because the brief named the opener | 18 | `LAB\skeptic1-planner\jev-hold-table.md` |

This amends `jev-research.md` P5 ("no position bias"): that held for identical clones; among distinct labels with
no brief the first-listed option wins.

### 5.3 Judgement nouls

Every noul except the newbie's `lost` (0.20 with banner vs 0.91 on an empty baseplate) and `suggests` (0.96-0.98
on the tutorial line) is a code fact: deadButton is delta emptiness (P2, P10), looksWrong fires only where
classify() or health already know (P9), done is a threshold reader (P4), exploit is a code gate. New on disk:
Jev's exploit noul on the 3.4 battery with the shipped criteria: legit spam 0.05 (0/3 fires), jackpot 0.36-0.40
(0/3, a miss), passive income 0.67-0.72 (2/3 false positives) (`LAB\skeptic2-pa4\p12-rows.log`, 9 calls).

### 5.4 Conclusion

Jev does not steer. Not per tick (code computes the verb at 0 ms with no noise), not among code-vetted
candidates without a brief (its pick is list order), not on anything with a threshold. It may earn a call as a
semantic mapper from a brief to a distinct on-screen label, and as a judge of free text; both are event-driven,
async, and unproven against a code `includes()` over button text. The decisive test is the paired A/B in
section 9.

---

## 6. Coverage of the Roblox catalogue

Source: rblxdb most-played chart, 2026-09-20, n=100, 6,627,528 CCU, classified by input demand
(`LAB\combat\top100-classified.csv`; shares recomputed from the csv on 2026-09-21: A 46.2, B 12.2, C 10.9, D 10.4,
E 9.7, F 2.0, G 1.6, H 1.9, I 1.3, J 2.9, K 0.9% of CCU). Sample places: obby 76846718367805 (20 prompts, 0 NPCs,
streaming on), Final Eclipse 90044978600719 (8 Humanoid NPCs, 0 prompts), Aqua (empty)
(`LAB\referee-boundary\studio-edit-probes.json`, transcript-copied).

| Tier | Classes | Games | CCU share | What the loop needs | Status |
|---|---|---|---|---|---|
| 1 | A simulator/tycoon/+1 (33), B social/roleplay (8), I physics sandbox (2), K tower defense (2) | 45 | 60.5% | UI clicks at y+inset, walk-to, prompt hold, hold verb, equip via Luau | **In scope, not yet proven on a fresh profile**: the Poop macro got charge 1/2 and purchase 1/2 on the runs that count (`poop-run.json`, no `ResetData`); the 9.1 re-run is the status test |
| 2 | C RPG-lite/brawler (11), E horror/survival/round (15) | 26 | 20.7% | enemies with bearing/distance/LOS as code facts, same-frame aim, threat interrupts, a 4-state code FSM (approach / fire when ready / retreat under 30% / loot when clear) | **In scope with the combat probe fields**; aim 30/30 and edge-jump 3/3 proven on primitives; a real Tool kit against a moving NPC untested |
| 3 | F obby (5), J fishing bar (3) | 8 | 4.9% | Heartbeat-rate code trigger (edge-jump, bar/zone AbsolutePosition), moving-platform velocity, kill-brick tags; Pathfinding NoPath beyond 80 studs on the real obby (n=7, transcript-copied) | **Partial**: platforming by code Heartbeat helper, route choice by code; declare "no movement" mode as fallback |
| 4 | D shooter with opponents (11), G racing/driving (4), H sports/ball (6) | 21 | 13.9% | opponents (Chrrxs `multiplayer_playtest`, `numPlayers` "1-8", schema copied to `LAB\doc-revision\chrrxs-multiplayer-schema.txt`, untested live), vehicles (`VehicleSeat.Throttle/Steer` exist per the api-dump, `LAB\doc-revision\external-facts.md`; that the default controls map WASD onto them is Roblox reference behaviour, external, not in LAB), ball hit windows | **Out of scope for now**; solo Play has no opponents |

Solo Studio Play reaches the core loop fully in 60 games, partially in 38, not at all in 2 (Murder Mystery 2,
Forsaken). Declared out: parry/hit-window games (Blade Ball, Volleyball Legends, soccer), drift/shift timing,
asymmetric PvP with no PvE, rhythm, social-RP cores that need other humans, anything behind `TeleportService`
(Roblox docs: teleports do not run in Studio playtests; external, not in LAB, `LAB\doc-revision\external-facts.md`),
DataStore-gated content when API access is off. Small-studio users skew toward tier 1 and
obbies (Newzoo daily visits: Roleplay 116M, Simulation 110M, Platformer 70M, Survival 70M, Action 59M); Dave's own
open place is an obby, his two agent-built games were survival (tier 2) and an extraction shooter (tier 4).

Roblox's free Playtest Agent (Studio Assistant beta, 2026-04-09) is goal-directed, 50-turn capped, admits false
passes and "no real-time reflexes" (`LAB\market\market-ledger.md`). The reach that survives its roadmap is
exploratory multi-persona play, dead controls, first-session stalls with screenshot and on-screen text, exploit
gates, and repro + file:line inside the IDE.

---

## 7. The lab and the Verifier

### 7.1 The persona lab (`LAB\persona-lab\persona-lab.md`)

| Aspect | Finding | n / file |
|---|---|---|
| Layout | K Studio windows on K published copies of the place, each a separate ~1 GB process addressed by instance id through either bridge; this box (32c/64t, 127 GB) holds 8-16, a 16 GB laptop 2-3. Multiplayer_playtest (1-8 clients) gives one shared world, so it serves multiplayer bugs, not funnels | Get-Process n=3; `LAB\doc-revision\chrrxs-multiplayer-schema.txt` (verbatim `dist/index.js` 16432-16450, 13492-13530) |
| Runner | The existing `play.mjs` in a CLI loop over Chrrxs with the bridge pre-started, a /health pre-flight and one retry; the QA view is single-child by design; no scheduler | `qa.ts:104`, `chrrxs.mjs connect()` |
| Per run | 2.1-2.5 s per step today; ~90 s for a 34-40 step Poop run incl. start/stop; a 241-step run completed | R1, R2, R3, qa-live-3 |
| Cost | Jev $0.0014 per run, $0.07 per 50-run lab; Claude triage $0.35-0.60 per run (estimated, `total_cost_usd` unrecorded) is >99% of model spend, so triage runs once per lab over the union of keys (~$0.5) | jev-research 1.1; `qaTriage.ts:50-79`; `LAB\doc-revision\pricing.md` section 7 (token arithmetic at Opus 5 rates, no envelope) |
| Rate limit | TypeSafe 1,200 req/min caps a 300 ms Jev tick at ~6 parallel personas; event-driven choice (one call per 3-10 s) fits 50; with Jev out of the tick the ceiling is Studio processes | jev-research D4 |
| Launch reliability | 5 of 10 recorded launches took 0 steps (4 seat-taken, 1 stopped); 0 of 5 after the Chrrxs fallback connected | report.json failure fields |
| Stable unit | "key flagged in run" (0/1), never note counts (8 vs 20 on the same game and agent); report runs-flagged/n with a Wilson interval | R1, R2 |
| Runs per persona | 10 (newbie 20): n=9 catches a q=0.3 finding once at 95%; n=11 gives ±0.25 at 90% | binomial |
| Aggregator | `lab-aggregate.mjs` computes stall cells, dead controls by key, crashes by fingerprint, exploits, funnel, first earn/spend from today's report.json; first spend censored 2/2 on Poop (the ui persona never earns) so the money funnel needs a spender persona | `LAB\persona-lab\lab-report.md` |
| Aqua | one ingest per lab (grouped by fingerprint, one jobId) from the canonical place only, else `distinct_servers` lies | `docs/aqua.md` sections 5-6 |
| Terms | Studio-only automation on your own place is within the Studio License and a documented product surface (StudioTestService, VirtualInput, MCP); live-server bots, alt accounts, Team Test as a lab and engagement inflation are not; Restrictions of Use (d) on AI is grey; no "robot/spider/crawler" clause in the current text (0/1,562 sentences) | `LAB\persona-lab\tou-section8.txt`, `tou-grep.mjs` |
| Open Cloud Luau execution | headless server-only (no clients, no physics, 5 min/task, 10 concurrent): fits Verifier/referee checks, not play | devforum 3172185 (external, not in LAB; quoted in `LAB\persona-lab\persona-lab.md:25`) |

### 7.2 The Verifier (`LAB\verifier\`)

No model at all. Replay the recorded path by intent (click by instance path re-resolved against the current probe
with `inWindow` required; walks as MoveTo to the recorded resulting position), stop one step past the finding,
decide in code: an error is gone when no console line carries the recorded fingerprint; a dead button is gone when
the code delta after the replayed click is non-empty (excluding repeat console lines).

| Determinism fact | Value | File |
|---|---|---|
| Spawn R1 vs R2 | 0.01 studs apart; leaderstats identical; health 100 | `determinism.out.txt` |
| GUI paths | 34/34 identical across runs; 14/14 R1 click paths recur in R2 | same |
| Key-hold walks | 25.06-25.60 studs when unobstructed (n=5) but 0.75-25.6 overall (n=32): not replayable; MoveTo instead | same |
| Position noise on click steps | up to 3.5 studs after a jump-walk (3/40): tolerance 5 studs | same |
| Recorded clicks off-viewport | R2 16/26, R1 5/14: replaying pixels replays misses; replay by path | same |
| Console chatter | R1 lines on 12/39 steps, R2 2/34: only fingerprinted error lines count | same |
| Screenshots | R2 steps 10-32 are 17 byte-identical frames (and steps 7-9 another three): not an oracle | `docs/jev-research.md:160-162` |
| Per-exposure reproduction of the Tier#.Hit note | 0.9 (18/20); three replays bound a missed unfixed bug at 0.001 | R2 report.json |
| Cost per verification | ~20-25 s Studio, $0 | derived |
| Offline check | `check.mjs`: 26 R2 clicks resolve, rename/gone/off-window handled, walk→MoveTo, 9 verdict cases pass; sibling stand-in bug caught (deleted Tier1 must not resolve to Tier2) | `LAB\verifier\check.mjs` |
| Repo change | `play.mjs`: 1-line policy import (:203), 1-line abort after decide() (:326); new `policy-replay.mjs` (~80 lines), `verify.mjs` (~50) | `policy-replay.mjs` header |

Protocol: Reproduce → Fix → Verify. One replay against the unfixed code must read "present" (else the finding is
labelled flaky), then 3 replays after the fix; "fixed" = gone 3/3; gate each replay on step-1 leaderstats equal to
the recording and spawn within 0.5 studs (DataStore persistence would break the restore silently; Poop uses
ProfileStore and the Studio profile now holds ~4,856 Coins after the hold runs, so `DevCommands ResetData` must
precede any fresh-player run). Trigger: `vscode.workspace.onDidSaveTextDocument` on the finding's file, debounced,
then an edit-DataModel `Source` hash gate to prove Script Sync shipped the edit, then `node qa/verify.mjs`. A
"gone" verdict writes the path as a regression test for free. The seven-replay experiment (arm A unchanged 3x
"present", arm B with a planted client-side fix 3x "gone", arm C Interactable=true only "present") has not run;
if arm A reproduces <3/3, dead-button findings on this game are not verifiable by replay.

---

## 8. Alternatives considered

| Alternative | Cost / latency | What it cannot do | Verdict |
|---|---|---|---|
| **What we have plus better probes** (scripted policy, code facts: interactable/inWindow filter, dead-button bit, exploit gate, GuiInset fix, `hold`/`equip` verbs, once-per-lab triage) | $0 per tick; 300-450 ms tick; deterministic; ~10-line dead-button note + a spam verb | semantics (brief→button, newbie `lost`) | **Adopted as the baseline arm.** On the planted-place channel table it reaches every target the Jev ui/explorer/breaker agents reach; R6's Jev pick agreed with it 4/4 on multi-option steps, and 10/14 of R6's calls had a single option |
| Planner + code macros + code referee, Jev out of the tick (this document) | plan $1.46 once per game version, re-plan ~$0.20, tick $0 | reactive novelty mid-subgoal (re-plans, as the original design does) | **Adopted** |
| Planner + per-tick Jev reflex (`jev-play-flow.md` as drawn) | $0.29-0.71/h Jev at 3 Hz (`LAB\doc-revision\pricing.md` section 4), 220-380 ms tick | thresholds, conjunctions, aim and jump windows (44-105 ms), turn actuation | **Rejected** (section 5) |
| Jev event-driven among <=7 code-vetted macros (R2/PA2 as written) | ~1 call per macro | this is already the shipped loop (one Jev POST per completed action); the change is the macro executor and interrupts, which contain no Jev question; without a brief its pick is list order | **Refuted as a change**; kept only as "Jev asked when brief/persona set and 2+ distinct candidates", log-only until the A/B |
| Haiku-class text chooser, event-driven, same `options()` (the missing comparator between "Jev at $0.00005" and "Claude re-plan at ~$0.20") | **projected** $0.0011-0.0016 per call, $0.4-1.9/h at 1 call per 3-10 s (`LAB\doc-revision\pricing.md` section 6); latency unmeasured (expected 0.5-2 s vs Jev's 145 ms) | n=0 calls; nothing measured | **Untested**. The one place Jev plausibly earns a call (brief → distinct label 12/12) has no comparator; add it as a third chooser arm to 9.2 step 1 |
| Code-as-policies: Claude writes a per-subgoal Luau controller run in the client VM (Heartbeat loop, MoveTo, InputHoldBegin, CreateVirtualInput click) | ~$0.03-0.08 per subgoal, 60 Hz in-engine, 0 bridge calls per tick | needs a pcall/timeout/allowlist sandbox; cannot react to novelty mid-subgoal | **Second experiment**: the combat probes already prove the primitives from the eval identity; a 15-minute spike closes it |
| Claude vision at 1 decision per 5-10 s | **projected** Haiku 4.5 $0.9-1.9/h, Sonnet 5 $1.9-3.8/h, Opus 5 $4.7-9.5/h (`LAB\doc-revision\pricing.md` section 5: ~1,033 image + ~1,000 state tokens per frame, 360-720 frames/h, external image-token rule); the only measured part is the screenshot, 1.0-1.4 s, so 2.5-5 s per loop | tick speed; pixel coordinates (BALROG: vision lowered GPT-4o 32→23%; VideoGameQA UI unit test 40%) | **Fallback**, n=0 frames measured, for places whose probes are blind (custom UI without GuiButtons, 3D-only cues); measure 20 frames first |
| Local 3-8B model on the RTX 4080 | $0, ~50-150 ms expected, deterministic at temperature 0; no runtime installed | n=0: nothing was run; its only argued advantages are determinism and offline, since Jev already costs ~$0 | **Not now**, untested; majority-of-3 Jev calls first if determinism matters |
| RL per game (EA/Ubisoft pattern) | days of Studio per policy; nothing transfers across Roblox games | | **Not viable** at Studio's sample rate |
| In-Luau loop calling TypeSafe from a server Script | removes the bridge | needs `HttpService.HttpEnabled` (Write = LocalUserSecurity per the api-dump, copied to `LAB\doc-revision\external-facts.md`; a saved Game Setting) and puts the API key in the Play DataModel | **Rejected** unless the one-eval-per-tick shape fails to reach 3 Hz |
| Open-source `kevinnie2003/playtest-agent` shape (code oracles decide, LLM only when stuck and at end-of-run) | ~20 LLM calls per episode; 8/8 seeded bugs, precision 1.00 | its game is a toy dungeon | **Adopted as the shape** of the baseline arm |
| Roblox Playtest Agent (free, in Studio) | 50-turn cap, daily cap | exploration, personas, real-time reflexes, false passes | The thing to position against, not to rebuild |

Prior art that decided the boundary (`LAB\prior-art\survey.md`): GITM 67.5% with scripted verbs vs VPT 20% /
DEPS 0.6%; DEPS 60% with an oracle controller vs 0.59% learned; SayCan's chooser was 65% of errors even at 540B
and its code affordance gate was worth 17 points; SwiftSage escalates on code rules and its fast model was
fine-tuned, not zero-shot; TITAN's 12-point gain came from GPT-4o over ~5 RAG-pruned options with a 30% false-alarm
oracle; no published system runs a model at 3 Hz in a 3D game (Cradle pauses the game; VideoGameBench real-time
0.48% vs paused 1.6%; Roblox's agent is turn-based).

---

## 9. Roadmap

### 9.1 The smallest convincing proof (one experiment, one metric, one week)

**Close the planner + code loop on Play With Your Poop with no Jev in the tick, against a no-plan arm.** What it
proves: the executor and the 4.4 contract (a plan-driven subgoal machine reaches the purchase through the bridge on
a fresh profile) and, with the second arm, whether the plan adds anything over a scripted policy given the same
verbs. It does not prove the planner's judgement on a new game (n=1 game, n=1 plan).

Pieces: the GuiInset fix in `probe.client.luau` (emit `y = cy + GuiService:GetGuiInset().Y`, fix `inWindow` in the
same frame), `hold` and `equip` verbs in `act()`, `chrrxs.mjs` mapping `mouseButtonDown/Up` and a `wait` step, the
plan contract of 4.4 (accumulated-text semantics, done before fail, raw-list evaluation, subsequence path match),
and a 60-line subgoal machine in `play.mjs` that picks by `prefer` when one candidate resolves and untried-first
otherwise.

- Plan artifact: `LAB\claude-planner\plan.json` as recorded ($1.46), re-linted under the 4.4 semantics. Two of its
  subgoals only work under those semantics (walk-to-line's `text_gone` never fires against a start snapshot;
  practice-throw-finish's `text_gone "Skip"` is a false positive over the filtered list), so what runs is the
  re-linted plan, not a byte-identical copy of the recorded one; record the lint diff with the run.
- Before every run in both arms: `DevCommands ResetData` (`DevCommands.luau:52` restores the template profile and
  re-arms the tutorial). The Studio profile currently holds ~4,856 Coins, LVL 6, Solid owned, tutorial at 2/4.
- Arm A (plan): the subgoal machine reads plan.json, 5 runs. Arm B (no plan): `--policy scripted` with the same
  `hold`/`equip` verbs and the same GuiInset fix, no plan.json, 5 runs, alternated with arm A.
- Metric: `buy-solid.done` (Coins delta <= -500 AND "NOW CLOSE THE SHOP" on screen) reached within budget, per run;
  require `holdTextSeen=true` ("HOLD ANYWHERE TO CHARGE" was actually on screen) before counting any charge pass.
- Pass for the executor + contract: arm A >= 4/5. Pass for "the plan earns its $1.46": arm A reaches `buy-solid.done`
  in fewer ticks than arm B in >= 4/5 paired runs, or arm B never reaches it (the scripted policy has no notion of
  "hold at the line", so it may never earn the 500 coins).
- Baseline: none comparable yet. The three recorded macro runs (`LAB\skeptic1-planner\poop-run.json`) ran without
  `ResetData`: fresh-profile charge 1/2, purchase 1/2 with coins >= 500 (section 1). Add the ResetData step to
  `poop-run.mjs` and re-run `node poop-run.mjs 3` (or 5) first; that k/n on fresh profiles is the macro baseline the
  two arms are measured against.
- Budget: 10 runs x ~2 min Studio plus the 3-5 baseline runs, $0 model spend (plan cached), one day of code, one day
  of Studio.
- Record per run: pass/fail, ticks per subgoal, `holdTextSeen`, the `release charge= held=` console line (hold
  jitter), which fail leaf fired, Jev calls (must be 0).

If arm A fails on the silent no-charge (1/2 seen on fresh profiles), add the code fact `chargeStarted` (text
"RELEASE TO THROW!" or the `launch` console line within 2 ticks) and retry the hold once; if it still fails, the
conclusion is "not this way" for hold-driven FTUEs through Chrrxs and the hold moves plugin-side.

### 9.2 The next three steps

| # | Step | Before | After (pass) | Cost |
|---|---|---|---|---|
| 1 | **Does Jev earn any call?** Build and publish the planted place (`jev-research.md` 4.6, E12). Add `--chooser code|jev` to `policy-jev.mjs` (same `options()`, same nouls, only the argmax source differs; log Jev's `next` in both arms). A/A block (E13, K=8), then K=8 pairs x {no brief; brief in on-screen words; persona newbie}; optionally a third chooser arm, Haiku 4.5 over the same `options()`, so the brief → label case has a comparator (section 8). Metric: steps to brief target (sign test), plus cov(end), notes per key, T_bug as no-harm checks | Jev picks first-listed 9/9 with no task; R6 agreement with scripted 4/4 on multi-option steps (10/14 calls single-option); no paired scripted-vs-Jev run exists anywhere | Jev not better on steps-to-target under brief and persona → code chooser only, Jev nouls log-only. Jev better only in brief/persona cells → Jev asked only there | ~2 h Studio, Jev < $0.10 |
| 2 | **Verifier live.** The seven-replay experiment on R2's Tier1.Hit finding (arm A unchanged x3, arm B planted client fix x3, arm C Interactable=true only) after copying `policy-replay.mjs`/`verify.mjs` into `qa/` and the two one-line `play.mjs` changes | Offline check passes (26 clicks resolve); 0 live replays | A present 3/3, B gone 3/3, C present, 7/7 paths resolved; then the onDidSave trigger with the Source-hash gate | ~3 min Studio, $0 |
| 3 | **Lab P1 → P2.** 8 sequential ui runs on Poop through the CLI loop with the bridge pre-started, `lab-aggregate.mjs` over the union; then two windows on two published copies at once | 5/10 launches took 0 steps; per-run triage; no aggregate exists on >2 runs | 8/8 take steps; keys bimodal (>=6/8 or <=2/8); coverage sd < 4; one union triage with `total_cost_usd` recorded; P2 both reports complete with distinct studio ids and per-step wall <= 1.3x sequential | 15 min + 10 min Studio, ~$0.02 Jev + one triage |

Then, in order: re-run the `studio-edit-probes` Luau through `execute_luau` from a small `.mjs` that writes the JSON
(obby Pathfinding at 17/44/80/150/300/634/3,369 studs, `GetDescendants` scans on three places, engine defaults;
edit mode, no Play, ~10 min) so the transcript-copied rows in sections 1, 2.3, 3.1 and 6 get a script on disk; the
code-as-policies spike (one client ModuleScript: Heartbeat loop, MoveTo to the nearest prompt,
`InputHoldBegin/End`, `CreateVirtualInput` click at AbsolutePosition+inset, `_G` log read 10 s later); the reach
experiment (`LAB\skeptic2-r1\reach.mjs`, moveto vs path vs teleport over 3 places, 90 trials, decides whether
Pathfinding earns its lines); the combat probe fields on the obby and a gun-kit place; the planner on 3 more
catalogue games at two models; a commercial pilot on one live simulator/tycoon (1k-10k DAU) with the metric
"one developer-confirmed bug or stall the developer did not know about" (two pilots at 0 → "not this way" for the
exploratory product).

---

## 10. Refuted ideas and why

| Idea | Why not | Evidence |
|---|---|---|
| Option A: Jev chooses turn/step/jump every ~300 ms | 21/30 raw, 30/30 only when code has computed the label; 0/6 on two-condition rules at thresholds; fine verbs dilute margin 0.97→0.55; arrows turn the camera not the character; 4.8 studs per tick blind | section 5; `LAB\liveLab\results.json` turning |
| A 300 ms tick with Jev inline | Sequential floor 66+17+145+117-167 = 345-395 ms; today 640-670 ms overhead per step (n=7; 22, `LAB\doc-revision\step-overhead.json`); 300 ms needs one window per tick and Jev async | `LAB\combat\tick-floor.json`, `timing.json`, `LAB\doc-revision\step-overhead.json` |
| Reflex cost "about $0.05 per hour" at 3 Hz | 3 Hz = 10,800 calls/h x 650-1,555 tokens (`jev-research.md:44`, runner shape, n=116) x $0.042/M = $0.29-0.71/h; at the jevSteer battery shape (1,146-1,413 tokens mean) $0.52-0.64/h; the figure implies ~110 tokens per call. The shipped one-POST-per-action loop measured $0.043/h (R6: 14 calls, 17,574 tokens, 61.9 s), so $0.05 was right for the shipped loop and wrong only for the 3 Hz reflex | `docs/jev-research.md:44`, `LAB\jevSteer\tables.md`, `LAB\skeptic2-pa2\r6-call-audit.json`, `LAB\doc-revision\pricing.md` section 4 |
| The combat-yard A/B/C (R5) as written | Arm A cannot run at 350 ms; four of its six actuators are unverified or wrong (Space tap untested, Humanoid.Jump 0/8, arrows turn the camera, single ClickDetector click fails); B and C are the same policy plus a one-option POST; "A not better on any of 7 metrics" at K=8 is undecidable; the fixture does not exist; the Jev half is already answered offline | reviews of R5 |
| Jev event-driven among macros (PA2/R2) as a change | The runner already POSTs once per completed action; the 300 ms clock exists only in the flow doc; "arrival, delta, stuck counter" events are code; without a brief the pick is list order; a fixed clock on a quiet screen already costs 0 calls (same-body cache) | `LAB\skeptic2-pa2\r6-call-audit.json` |
| Three-arm oracle-controller ablation (PA3) | Arms collapse on a UI place (cov saturates at 1.0 for both); the code-only arm has no notes/exhausted without `action.jev`; the brief/persona cells where Jev could differ have no arm; the planted place, a runner planner and `bench ab` do not exist | review of PA3 |
| Jev at the subgoal/candidate layer (S2) | Its 98-100% numbers are lookups over code thresholds; no-ground-truth choice = position (9/9 first-listed even with every option naming its fact); nouls over code booleans are re-reads with a 0.7-crossing risk | `LAB\skeptic-s2\tables.md`, `LAB\skeptic2-S2\boundary3.log` |
| Jev's exploit noul as the gate | Legit spam 0.05 (fine), jackpot 0.36-0.40 (missed), passive income 0.67-0.72 (2/3 false); the code gate is 7/7 in `qa-check.mjs` | `LAB\skeptic2-pa4\p12-rows.log` |
| `key {key_code}` for hotbar equip | Chrrxs 0/3; built-in refuses CoreGui-bound keys (One..Nine, Backspace, Escape) and CoreGui pixels; `Humanoid:EquipTool` 1/1 | `LAB\skeptic1-planner\builtin-probe.json` |
| Verify the GuiInset once with the Skip button | Skip's corrected point (54, 34) sits in the topbar band CoreGui owns: the built-in bridge refuses CoreGui pixels outright ("VirtualInput::SendMousePosition: position (1426.0, 858.0) hits CoreGUI", the hotbar case in `builtin-probe.json`), and the game's `beginCharge` returns while `GuiService.MenuIsOpen` (`ThrowController.luau:675-681` in the Poop mirror). That a Chrrxs click at (54, 34) opens the Roblox menu is inferred from R2's screenshot geometry and the game source, observed nowhere: no run clicked Skip at its corrected point (`poop-run.json` records only `skipButton {x:54, y:-24, inWindow:false}`). Use IndexBtn/ShopBtn instead (done: raw 0/3, +58 3/3) | `LAB\skeptic1-planner\builtin-probe.json`, `poop-run.json`; the menu chain: inferred, not recorded |
| Fix the inset in `chrrxs.mjs:141` | Pass-through is the vendor contract; callers that supply window-space pixels (ClickDetector centre click, WorldToViewportPoint aim) must not get +58; fix where GUI-space numbers originate (`probe.client.luau`) | plugin comment MCPPlugin.rbxmx:4184-4207 |
| Double-click every ClickDetector | Prime once per interact (the cursor moves on button-down), then N clicks; a blind double inside the `times` loop gives 2n-1 fires and corrupts the exploit gate's per-use stat; compute the pixel with WorldToViewportPoint on the client, not the viewport centre; 0 ClickDetectors in all three test places, so P2 | `LAB\liveLab\results2.json` clickDetector |
| Plan cache keyed on `placeVersion` | Reads 0 in all 5 recorded Studio Play runs that carry the field (R1, R2, R6 on Poop; qa-live-2, qa-live-4 on Aqua); hash the Script Sync mirror instead (152 files hashed in <1 s) | `LAB\doc-revision\placeversion-tally.json`, `LAB\skeptic-p4\resume-results.json` (mirror hash) |
| Re-plan via `--resume` and hold the run at 300 ms so the 5-min TTL covers the session | Warm $0.36-0.43 (n=3, median $0.40), cold $1.16 (n=1), wall 46-70 s (fails the <60 s rule 2/3), output tokens are 55-75% of cost, `total_cost_usd` is cumulative across resumes, two runs resuming one session interleave; a fresh stripped call is $0.11-0.20 | same |
| Last-2-segment suffix matching for plan paths | Recovers 30/31 but 3 hit the wrong panel's CloseButton (rebirth pattern matches Worlds and Shop); subsequence match with a literal panel segment is 31/31 with 0 wrong | `LAB\skeptic-p2\match-compare.json`, `retally.mjs` |
| Adopt the plan contract exactly as prototyped (P1) | `text_gone` against a start snapshot never fires for walk-to-line; the filtered-list Skip false positive; fail true when done true; 3/7 subgoals need verbs the loop lacked; its proof re-fed the evaluator's own three observations | `LAB\claude-planner\check-results.json`, `LAB\skeptic2-planner\check.mjs` |
| `Humanoid.Jump = true` from an eval | Stomped every RenderStepped by the ControlModule: 0/8; `ChangeState(Jumping)` 3/3 | `LAB\combat\play-probe*.json` |
| "Mouse-look is impossible through Chrrxs" | The plugin exposes no move action, but `CreateVirtualInput()` from `eval_client_runtime` has `SendMousePosition`/`SendMouseDelta` (6/6 methods present, Mouse.Target 3/3) | `LAB\combat\aim-probe.client.luau` |
| Screenshots per tick, or as a determinism oracle | 1.0-1.4 s regardless of format; 17 byte-identical frames across changing steps; one action late | liveLab, verifier |
| Input-level replay for the Verifier | 16/26 R2 clicks were off-viewport (replays misses); key-hold walks 0.75-25.6 studs depending on obstacles | `LAB\verifier\determinism.out.txt` |
| Jev as an "is it fixed" question | Noise floor 0.03-0.065 on a yes/no code answers exactly | jev-research P1 |
| RNG seeding of the game for replay | `math.random`/`Random.new()` are per-VM; handle with "reproduce first" instead | verifier design |
| In-Luau TypeSafe loop from a server Script | `HttpService.HttpEnabled` Write = LocalUserSecurity; key in the Play DataModel | `LAB\doc-revision\external-facts.md` section 1 (copied from `tmp\api-dump.json`) |
| Claude vision as the tick | 2.5-5 s per loop; vision lowers agent scores and misreads pixels; $0.9-9.5/h | prior-art survey; alternatives |
| RL, local model | Studio runs one real-time Play per window at 0.45-2 s per bridge step; nothing transfers; Jev already costs ~$0 | alternatives |
| Per-run Claude triage in a lab | $20-30 per 50-run lab vs ~$0.5 once over the union of keys | persona-lab section 2 |
| `jev-research.md` P5 "no position bias" as a general claim | Holds for clones only; distinct labels with no task: first-listed 0.87-0.97 | `LAB\alternatives\results.jsonl` |
| Selling "verify that X works" | Roblox gives that away free in Studio; sell what its agent admits it lacks | `LAB\market\market-ledger.md` |

### Not established (carried forward)

A closed-loop Jev-in-the-tick run in Studio (n=0 anywhere); a fresh-profile (`ResetData`) run of the Poop macro or
of any plan (none recorded; the 1/2 and 1/2 in section 1 are the honest reading of mixed-profile runs); the obby
Pathfinding, instance-scan and engine-default numbers from a script on disk (transcript-copied); probe cost on a
50k-instance place (GetDescendants was 14.1 ms at 37,874 instances in edit mode, transcript-copied; the per-tick
Humanoid scan is untimed on a populated place); Pathfinding on any catalogue lobby (n=1 baseplate, n=7 edit-mode
obby, transcript-copied); a real Tool kit firing at `Mouse.Hit`
with server damage; `multiplayer_playtest` live and per-client screenshots; the built-in MCP hold across two calls;
Space-tap jumps through VirtualInput; the cause of the 1/3 silent no-charge and the 1/3 bridge death; planner
variance and other-model quality; whether `lost` has any recall; the exact Holy-throw payout; Roblox's Playtest
Agent daily cap; any Roblox studio that has paid for non-human automated playtesting (none found).
