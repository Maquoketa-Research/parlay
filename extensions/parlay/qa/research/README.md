# Jev research: probe scripts and captured results

Evidence for `extensions/parlay/docs/jev-research.md`. Copied from `C:\Users\Dave.MAQUOKETA\.claude\jobs\260ad20a\tmp\research\`
on 2026-09-20 (E0b of the doc, section 5). Nothing here ships; nothing here is imported by the runner.

- `experiments.mjs` + `lib.mjs` wrote `results.jsonl` (116 rows), `conditions/*.json` (38 exact bodies) and `tables.md`.
- `skeptic-r2-buckets.mjs` wrote `skeptic-r2-buckets.results.json`.
- Every other script printed to the console; `results-skeptic/<script>.log` is the E0b capture (first line: shell date).
  Those re-runs were pinned to `model: "jev-1.13.0"`, use 3 reps per condition unless noted, and import the frozen
  `agents.9ee28b1.mjs` (the `agents.mjs` the doc cites, at commit 9ee28b1c85f) instead of the live file, so a later
  criteria change cannot move the numbers. 191 requests in total (roughly 1,000 input tokens each, under a cent).
- `FORCE_COLOR=3` was set in the capturing shell, so `console.log` emitted ANSI colour codes; they were stripped from
  the logs in place (`sed 's/\x1b\[[0-9;]*m//g'`), which changes no number or line count.
- `lib.mjs` still hard-codes the original `DIR` (the tmp path); it is a record, not a tool to re-run from here.
- No file here contains the TypeSafe key (scanned for its first six characters after copying: clean).

Original locations of the three scripts that were outside `research/`: `tmp/jev-repeat-probe.mjs`,
`%TEMP%\jev-determinism-probe.mjs`, `%TEMP%\jev-steer-test.mjs` (now `skeptic-r9-steer.mjs`).

## P# id → file and line

Line numbers are 1-based; line 1 of every log is the date. "Doc" is the number quoted in jev-research.md §1.2 / §3 / §6.

| Id | Claim in the doc | File : line | Re-run value |
|---|---|---|---|
| P0 | latency n=116: p50 145, p90 240 ms | `results.jsonl` :1-116, field `ms` | on disk |
| P1 | identical request ×5 (Exp 6) | `results.jsonl` :10-14; `tables.md` :21 | on disk |
| P1† | second probe, top option sd 0.033 pinned (0.065 alias) | `results-skeptic/jev-repeat-probe.log` :11 (p(click_8) sd), :5 (argmax 6/6 same), :14-18 (noul sd) | pinned sd 0.059; argmax stable 6/6; noul sd ≤ 0.028. Alias and `jev-1.12.0` arms not re-run (pin rule) |
| P2 | delta present vs absent (Exp 3) | `results.jsonl` :39-50; `tables.md` :87 | on disk |
| P2† | consoleLines 0→1: deadButton 0.92→0.10 | `results-skeptic/jev-determinism-probe.log` :3-7 (same body ×5), :8-10 (consoleLines 1), :11 (state as string) | 0.92-0.94 → 0.09-0.10 |
| P3 | verdict key leak (Exp 4) | `results.jsonl` :51-59; `tables.md` :110 | on disk |
| P4 | done vs sinceNew 0..5 (Exp 5) | `results.jsonl` :60-77; `tables.md` :129 | on disk |
| P4† | cap 5 + "8 or more" → 0.15/0.14/0.15; cap 8 → 0.83/0.83/0.84 | `results-skeptic/skeptic1-r5-done-probe.log` :3 (B), :4 (C); :2 (A today), :5 (D real end state) | B 0.13/0.13/0.15; C 0.83/0.83/0.83; A 0.83/0.82/0.83; D 0.72/0.74/0.76 |
| P5 | distinct vs identical options (Exp 1, 1b, 1d) | `results.jsonl` :1-9, :15-23, :114-116; `tables.md` :2, :34, :229 | on disk |
| P6 | instruction clause (Exp 1c) | `results.jsonl` :24-29; `tables.md` :53 | on disk |
| P7 | state format (Exp 2) | `results.jsonl` :30-38; `tables.md` :68 | on disk |
| P8 | brief reach (Exp 7, 7b) | `results.jsonl` :78-86, :111-113; `tables.md` :160, :218 | on disk |
| P8† | reworded brief appended: target 0.73-0.75, wins 3/3 | `results-skeptic/skeptic1-r7-probe.log` :7-9 (V1); :3-5 (V0 replication), :11-13 (V2 + ancestry), :15-17 (V3 no move clause) | V1 0.73/0.79/0.71, wins 3/3; V0 target 0.05-0.07; V2 0.72-0.74 |
| P8† | task question picks explore 0.62-0.71 (conf 0.53-0.58) | `results-skeptic/skeptic1-r7-probe.log` :19-21 (V4); `results-skeptic/skeptic2-r7-taskq.log` :3-5 (T1) | explore 0.57-0.67, conf 0.50-0.62 (borderline, see below) |
| P8† | after completion task question fires 0.89-0.93 on CloseButton | `results-skeptic/skeptic2-r7-taskq2.log` :22-24 (T5); :18-20 (T3' plain: 0.57-0.59); `skeptic2-r7-taskq.log` :11-13 (T3 with explore: explore 0.72-0.76) | T5 0.92/0.93/0.93 |
| P8† | ancestry "Shop > Tier1" 0.17-0.24 | `results-skeptic/skeptic2-r7-taskq.log` :7-9 (T2 next); `skeptic2-r7-taskq2.log` :14-16 (T4 mechanical ancestry) | T2 0.19/0.24/0.24 |
| P9 | 5-level score (Exp 8) | `results.jsonl` :87-110; `tables.md` :179 | on disk |
| P10† | interactable=false ignored by today's criteria (0.93-0.94; no field 0.92-0.93) | `results-skeptic/skeptic2-r1-pairs.log` :3 (C1), :2 (C0); `probe-pairs.log` :5 (C1, n=1) | C1 0.94 ×3; C0 0.93/0.93/0.92; pairs C1 0.93 |
| P10† | field-only criteria: false → 0.07-0.08, true → 0.92 | `results-skeptic/skeptic2-r1-pairs.log` :8 (C6), :9 (C7) | 0.07/0.08/0.07; 0.91 ×3 |
| P10† | label-aware variant loses recall 0.53/0.68/0.71; labels alone 0.11-0.14; field alone 0.40-0.44 | `results-skeptic/skeptic2-r1-pairs.log` :5 (C3), :7 (C5), :6 (C4); `probe-pairs.log` :6 (C2), :7 (C3, n=1) | C3 0.69/0.67/0.58; C5 0.13/0.16/0.12; C4 0.44/0.39/0.38; pairs C3 0.70 |
| P11† | end state: 0.70-0.72 with text, 0.83-0.84 without, 0.86-0.87 "26 of 26", 0.87 bundled | `results-skeptic/skeptic1-done-probe.log` :2 (D1), :3 (D2), :4 (D3); `probe-agents.log` :2-4 (D4 bundled); `probe-pairs.log` :8-10 (D1-D3, n=1) | D1 0.70/0.70/0.68; D2 0.83/0.84/0.84; D3 0.84/0.87/0.86; D4 0.87/0.86/0.87; pairs D1 0.76, D2 0.86, D3 0.84 |
| P11† | integers everSeen 34 / everTried 26: 0.70-0.71; named comparison 0.05; all-tried 0.78-0.82 | `results-skeptic/skeptic1-done-probe.log` :6 (R3b), :7 (R3c), :8 (R3d); :5 (R3a), :9 (R3e hidden field: 0.43-0.48) | R3b 0.72/0.74/0.72; R3c 0.05/0.05/0.06; R3d 0.82/0.80/0.81 |
| P12† | legit spam 0.08-0.18; +100 after walk 0.50-0.66 (under 0.7) | `results-skeptic/skeptic-r7-probe.log` :2 (BR1), :4 (BR2); `probe-agents.log` :5-7 (BR1 bundled), :8-10 (BR2 bundled) | alone: 0.09-0.11 / 0.54-0.59; bundled: 0.12-0.17 / **0.67-0.70** (see below) |
| P12† | statsDelta named: exploit 0.91-0.92, legit spam 0.76-0.77, passive 0.78-0.81 | `results-skeptic/skeptic-r7-probe.log` :5 (BR2+statsDelta), :3 (BR1+statsDelta), :6 (BR3) | 0.92/0.93/0.90; 0.76/0.79/0.75; 0.76/0.76/0.79 |
| P13† | lost 0.20 with banner, 0.91 empty baseplate | `results-skeptic/probe-agents.log` :11-13 (NB1), :14-16 (NB2) | 0.20/0.18/0.18; 0.92/0.93/0.92 |
| P13† | persona: Newbie Hit 0.69-0.70, Explorer IndexBtn 0.52, UI IndexBtn 0.77 | `results-skeptic/skeptic-r8-newbie.log` :3-5 (A newbie), :7-9 (B explorer), :11-13 (C ui) | **Newbie CloseButton 0.82-0.84 (Hit 0.08-0.10)**; Explorer IndexBtn 0.57-0.58; UI IndexBtn 0.70-0.75 (see below) |
| P13† | quoting a code-matched banner flips the pick 0.19→0.63; Jev's own `suggests` names a different banner at 0.97 | `results-skeptic/skeptic-r8-newbie.log` :15-17 (D quoted on CloseButton), :19-21 (E quoted on Hit); `suggests` on every line :3-25 | D CloseButton 0.84→0.93-0.97; E Hit 0.10→0.23-0.24 (no flip); `suggests` = "CLOSE PANEL TO CONTINUE" 0.94-0.97, the same line the quote used |
| P13† | `suggests` 0.96-0.98 with banner, "Stud Shop" 0.52 without | `results-skeptic/skeptic-r8-newbie.log` :3-21 (with), :23-25 (F without) | with 0.94-0.97; **without: "SAVE UP" 0.98-0.99** (see below) |
| P14† | console injection looksWrong 0.07→0.77-0.81; criteria sentence → 0.40-0.42; `observed.*` → 0.79; done 0.01→0.02 | `results-skeptic/skeptic-r9-steer.log` :5 (A), :7 (C), :9 (E criteria only), :8 (D wrap + criteria), :10 (F wrap only), :6 (B text only) | A 0.06-0.07; C 0.78-0.81; E 0.43-0.47; D 0.37-0.42; F 0.79-0.82; done 0.01-0.02 everywhere |
| P15 | buckets vs integers, 9 states × 2 arms × 3 reps | `skeptic-r2-buckets.results.json` :1-307 (entries at :3, :20, :37, …, :292; `arm` numeric / bucket) | on disk |
| P16† | 19 Hit options vs 1 + explore: top-1 0.61→0.83 | `results-skeptic/probe-pairs.log` :11 (E1), :12 (E2) | 0.64 → 0.82 |
| D2 | `jev-1.13.0` accepted; unknown id → HTTP 400 | `results-skeptic/jev-repeat-probe.log` :4 (response.model jev-1.13.0) | the 400 arm was not re-run (pin rule) |

## Numbers that differ from the doc's † claims by more than 0.05, or break a qualitative claim

1. **P13† persona (skeptic-r8-newbie A-C).** Newbie picks CloseButton 0.82-0.84, not Hit 0.69-0.70 (Hit gets 0.08-0.10);
   Explorer IndexBtn 0.57-0.58 vs 0.52 (+0.06); UI IndexBtn 0.70-0.75 vs 0.77 (one rep −0.07). The transcript's option
   list is not on disk; this script offers one option per distinct untried button (IndexBtn, RebirthBtn, CloseButton,
   Hit in Tier2) on the NB1 state. The qualitative claim "persona text alone changes the pick" holds (three personas,
   three different distributions, two different argmaxes); the specific "Newbie picks Hit" does not reproduce when
   CloseButton is offered under a "CLOSE PANEL TO CONTINUE" banner.
2. **P13† quoting flip (D/E).** The 0.19→0.63 flip cannot be reproduced on this state because CloseButton already wins
   unquoted (0.84); quoting raises it to 0.93-0.97. Quoting the other banner on Hit moves Hit 0.10→0.23-0.24 without a
   flip. Directionally the same lever (+0.13 to +0.14 of mass onto the quoted option); the magnitude claim is unverified.
3. **P13† `suggests` "different banner at 0.97" and "Stud Shop 0.52 without".** On this state Jev's `suggests` names
   "CLOSE PANEL TO CONTINUE" at 0.94-0.97, the very line the quote used, so "Jev's own answer is a different banner"
   does not hold here. With both banner lines removed it names "SAVE UP" at 0.98-0.99 (doc: 0.52 on a different label
   set), i.e. `suggests` is confident with or without a tutorial line; as a "did the instruction reach Jev" instrument
   it needs the log-only comparison against a known line, not its confidence.
4. **P12† BR2 bundled (probe-agents :8-10).** exploit 0.70/0.68/0.67 with the five-question bundle vs the doc's
   "0.50-0.66 (under 0.7)". Numerically +0.04, but one rep sits at the 0.7 note threshold, so "missed at 0.7" is not safe;
   exploit alone on the same state (skeptic-r7-probe :4) is 0.54-0.59.
5. Borderline (= 0.05, not more): task-question explore 0.57 vs the doc's lower bound 0.62 (skeptic2-r7-taskq :3-5,
   skeptic1-r7-probe :19-21); criteria-sentence looksWrong 0.47 vs 0.42 (skeptic-r9-steer :9), and §3.1's single figure
   "0.79 → 0.40" reads 0.43-0.47 here.
6. Not a >0.05 difference but a contrast that did not reproduce: P1† pinned top-option sd is 0.059 (doc 0.033), the
   same magnitude as the doc's alias figure (0.065). The alias arm was not re-run, so "pinning lowers the sd" is
   unsupported by this capture; argmax stability (6/6) holds.

Everything else in the table above is within 0.05 of the doc's quoted range.
