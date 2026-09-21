# Parlay QA: the play loop (planner, reflex, referee)

Three layers on three clocks. Claude reasons but is slow and costs money per call, so it plans once per subgoal.
Jev decides fast and for almost nothing, so it drives every tick. Code owns every fact, every completion check and
every safety rule, because neither model may guess at them (docs/jev-research.md, section 3).

```mermaid
flowchart TD
  Dev[Developer: Quality Assurance tab<br/>place · persona · task] --> Plan

  subgraph Plan["PLANNER · Claude · once per subgoal (10-30 s)"]
    P1[reads: task, on-screen text,<br/>scripts from Script Sync] --> P2[writes subgoals, each with a<br/>code predicate for completion<br/>e.g. dist(player, Shop.Door) &lt; 5<br/>clicked(Shop.Tier1.Hit)]
  end

  Plan -->|current subgoal| Tick

  subgraph Tick["TICK · ~300 ms · code-owned"]
    T1[PROBE (Luau in Play)<br/>position, heading, raycasts ×8,<br/>NPCs / tools / pickups with bearing + distance,<br/>buttons + text, stats] --> T2[REFEREE (code)<br/>deltas, untried, sinceNew,<br/>subgoal progress + completion,<br/>exploit gate, stuck, safety rules]
    T2 --> T3[REFLEX (Jev, ~150 ms)<br/>choice over fine verbs:<br/>turn L/R · step · jump · use prompt ·<br/>click X · equip · activate<br/>nouls: threat ahead? closer? looks wrong?]
    T3 --> T4[ACT · one Chrrxs input call]
    T4 --> T5[RECORD · jev.jsonl, stepsLog,<br/>screenshot when a note fires]
    T5 --> T1
  end

  Tick -->|subgoal failed ×3 · new panel · stuck| Plan
  Tick -->|done · exhausted · cap| Triage

  subgraph Triage["TRIAGE · Claude · once per run (~1 min)"]
    R1[errors + stack, dead controls,<br/>exploits, stuck, lost + the scripts] --> R2[bug / look / fine<br/>file:line, one sentence why]
  end

  Triage --> Fix[Fix with Claude<br/>at file:line]
  Fix --> Verify[Verifier persona replays<br/>the path that hit it]
  Verify -->|gone?| Report

  subgraph Lab["LAB · N personas × runs on the QA box"]
    L1[newbie ×20 · spender ×10 ·<br/>breaker ×10 · explorer ×10]
  end
  Lab --> Report[funnel: where they stall ·<br/>confusion hotspots · dead controls ·<br/>crashes · exploits · time to first purchase]
```

| Layer | Who | How often | Latency | Cost per hour of play |
|---|---|---|---|---|
| Referee | code (probes, runner) | every tick | ~50 ms | 0 |
| Reflex | Jev | every tick, ~3 per second | ~150 ms | about $0.05 |
| Planner | Claude | once per subgoal, and on failure | 10-30 s | about $1-3 |
| Triage | Claude | once per run | ~1 min | about $0.20 |

What exists today: the referee and the reflex at a 2-second tick with three coarse verbs (walk, click, interact),
the personas, the triage, Fix with Claude, the recording. What the plan adds: spatial facts and fine verbs in the
probe and the bridge, a 300 ms tick, Claude as the planner with code-checkable subgoals, the Verifier persona, and
the lab report over many runs.
