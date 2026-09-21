// The offline evaluation harness of docs/jev-research.md sections 4.3 and 4.4. Three commands, stdlib only:
//   node qa/bench.mjs score <run>...
//       every 4.3 row computable from report.json, plus jev.jsonl, stepsLog.jsonl, triage.json and labels.json when present
//   node qa/bench.mjs noise <run> [--states 15] [--repeats 6] [--model jev-1.13.0] [--out <dir>]
//       re-POST frozen jev.jsonl bodies (cached lines skipped; the lowest-margin steps plus any noul within 0.05 of its
//       threshold): per-question sd, top-label flip rate, threshold-crossing rate
//   node qa/bench.mjs replay <run>... --candidate qa/variants/<name>.mjs [--repeats N] [--questions a,b] [--model m] [--out <dir>]
//       rebuild each step's state from the line's raw probe (3.3 filter re-applied), history from report.actions, and
//       ask the baseline body and the candidate's body; identical bodies are sent once; per-step paired deltas per question
// Every number prints with its n; zero positives print "no positives; unmeasurable", never 0.0. The key is read from
// ~/.parlay/typesafe-api-key (or PARLAY_TYPESAFE_API_KEY / TYPESAFE_API_KEY) inside this script and never printed.
// Cost is usage.input_tokens × $0.042 per million (output is not priced). PARLAY_QA_JEV_URL points at a mock, as in qa-check.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ENDPOINT = process.env.PARLAY_QA_JEV_URL || "https://api.typesafe.ai/v1/systemone";
const PRICE = 0.042e-6;
const TAU = 0.7, TAU_DONE = 0.8;   // the code thresholds in notesFor and the done ender
const tau = (q) => q === "done" ? TAU_DONE : TAU;
const here = path.dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`bench: ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- small stats -----------------------------------------------------------------------------------------
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = (xs) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const mode = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
const f2 = (x) => Number.isFinite(x) ? (Math.round((x + Number.EPSILON) * 100) / 100).toFixed(2) : "—";   // half-up, so 0.175 prints 0.18 as the doc does, not toFixed's 0.17
const frac = (k, n, none = "no positives; unmeasurable") => n ? `${k}/${n} = ${f2(k / n)}` : none;
const withN = (x, n) => `${f2(x)}, n=${n}`;
// 1000 resamples of the per-step deltas; only called when n >= 30 (4.4)
function bootstrap(d, B = 1000) {
	const ms = [];
	for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(Math.random() * d.length)]; ms.push(s / d.length); }
	ms.sort((a, b) => a - b);
	return `[${f2(ms[Math.floor(B * 0.025)])}, ${f2(ms[Math.ceil(B * 0.975) - 1])}]`;
}

// ---- probabilities ---------------------------------------------------------------------------------------
const desc = (P) => Object.values(P).sort((a, b) => b - a);
const margin = (P) => { const s = desc(P); return s.length > 1 ? s[0] - s[1] : 1; };
const entropy = (P) => -Object.values(P).filter((p) => p > 0).reduce((a, p) => a + p * Math.log2(p), 0);
const top1 = (P) => desc(P)[0] ?? NaN;
const argmax = (P) => Object.entries(P).sort((a, b) => b[1] - a[1])[0]?.[0];
const isTarget = (id) => /^(click|interact)_/.test(id);
// mass on click/interact ids whose target is untried; without an offered map every target id is untried for agents
// that never repeat (they are filtered before being offered), so `offered` may be undefined for old runs
const massUntried = (P, offered, tried, repeat) => {
	const ids = Object.keys(P).filter(isTarget).filter((id) => offered ? offered[id]?.path && !tried.has(offered[id].path) : !repeat);
	return ids.length ? ids.reduce((a, id) => a + P[id], 0) : NaN;
};

// ---- files -----------------------------------------------------------------------------------------------
const readJson = (dir, f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { if (fallback !== undefined) return fallback; return die(`${path.join(dir, f)}: ${e.message}`); } };
// line by line: a run killed mid-append leaves a partial last line, which must not turn the whole file into "no jev.jsonl"
const readJsonl = (dir, f) => {
	let text; try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { return []; }
	const out = []; let skipped = 0;
	for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { skipped++; } }
	if (skipped) console.error(`bench: skipped ${skipped} unparsable line${skipped === 1 ? "" : "s"} in ${path.join(dir, f)}`);
	return out;
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
// the current keyOf (src/qaTriage.ts): kind + the judged action's path with digits folded, else the note text
const noteKey = (n) => `note:${n.kind}:${String(n.actionsBefore?.at(-1)?.action?.path ?? n.text ?? "").replace(/\d+/g, "#")}`;
function apiKey() {
	if (process.env.PARLAY_TYPESAFE_API_KEY) return process.env.PARLAY_TYPESAFE_API_KEY;
	try { return fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim() || process.env.TYPESAFE_API_KEY; } catch { return process.env.TYPESAFE_API_KEY; }
}
// the runner's siblings are landing their exports alongside this file: a missing one is a message, not a stack trace
async function load(file, want) {
	const mod = await import(pathToFileURL(path.join(here, file)).href).catch((e) => die(`cannot load qa/${file}: ${e.message}`));
	const missing = want.filter((k) => mod[k] === undefined);
	if (missing.length) die(`qa/${file} does not export ${missing.join(", ")} yet (it exports: ${Object.keys(mod).join(", ") || "nothing"})`);
	return mod;
}

async function ask(key, body) {
	for (let attempt = 0; ; attempt++) {
		const t0 = Date.now();
		const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }).catch((e) => die(`${ENDPOINT} unreachable: ${e.message}`));
		if ((r.status === 429 || r.status === 529) && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
		if (!r.ok) die(`HTTP ${r.status} from ${ENDPOINT}: ${(await r.text().catch(() => "")).slice(0, 200)}${r.status === 400 ? ` (model "${body.model}" unknown?)` : ""}`);
		const j = await r.json();
		return { answers: j.answers ?? {}, model: j.model, usage: j.usage, ms: Date.now() - t0 };
	}
}
// one answers.jsonl per invocation, next to the first run (runs with a jev.jsonl are new, hence writable)
function outDir(o, run, cmd) {
	const dir = o.out ?? path.join(run, "bench", `${cmd}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ---- score -----------------------------------------------------------------------------------------------
function loadRun(dir) {
	const report = readJson(dir, "report.json");
	const jev = readJsonl(dir, "jev.jsonl");
	return { dir, report, jevByStep: new Map(jev.map((l) => [l.step, l])), stepsLog: readJsonl(dir, "stepsLog.jsonl"), triage: readJson(dir, "triage.json", null), labels: readJson(dir, "labels.json", null) };
}

function scoreRun(r, AGENTS) {
	const { report, jevByStep, stepsLog, triage, labels } = r, acts = report.actions ?? [], N = acts.length, agent = AGENTS[report.agent] ?? {};
	const out = [];
	const row = (k, v) => out.push(`  ${k.padEnd(44)} ${v}`);
	const P = (s) => jevByStep.get(s)?.answers?.next?.probabilities ?? acts[s - 1]?.action?.jev?.probabilities;
	const flags = (s) => acts[s - 1]?.action?.jev?.flags ?? {};
	const triedBefore = (s) => new Set(acts.slice(0, s - 1).map((h) => h.action?.path).filter(Boolean));
	const wall = report.start && report.end ? (new Date(report.end) - new Date(report.start)) / 1000 : NaN;
	row("steps / wall s / doneBy", `${report.steps} / ${f2(wall)} / ${report.doneBy ?? report.failure ?? "?"}`);
	row("agent / policy / place", `${report.agent} / ${report.policy} / ${report.place}`);
	if (report.code) row("code version / promptHash", `${report.code.version} / ${report.code.promptHash}`);
	const byKind = {}; for (const n of report.notes ?? []) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
	row("notes by kind / suspects / stuck / errors", `${JSON.stringify(byKind)} / ${report.suspects?.length ?? 0} / ${report.stuck?.length ?? 0} / ${report.errors?.length ?? 0}`);

	// choice quality (2.3 / 4.3): the step subset is part of each definition
	const jevSteps = [...Array(N).keys()].map((i) => i + 1).filter((s) => P(s));
	const multi = jevSteps.filter((s) => Object.keys(P(s)).length > 1);
	const clicks10 = jevSteps.filter((s) => Object.keys(P(s)).filter((id) => id.startsWith("click_")).length >= 10);
	row("options per step (mean)", withN(mean(jevSteps.map((s) => Object.keys(P(s)).length)), jevSteps.length));
	const margins = multi.map((s) => margin(P(s)));
	row("margin p1−p2, median (mean), multi", `${f2(median(margins))} (${f2(mean(margins))}), n=${multi.length}`);
	const allMargins = jevSteps.map((s) => margin(P(s)));
	row("margin, median (mean), all Jev steps", `${f2(median(allMargins))} (${f2(mean(allMargins))}), n=${jevSteps.length}`);
	row("margin < 0.05, multi", frac(margins.filter((m) => m < 0.05).length, multi.length, "—"));
	row("entropy bits (mean), multi", withN(mean(multi.map((s) => entropy(P(s)))), multi.length));
	row("top-1 (mean), multi", withN(mean(multi.map((s) => top1(P(s)))), multi.length));
	const t10 = clicks10.map((s) => top1(P(s)));
	row("top-1 with ≥10 click options, mean (min)", `${f2(mean(t10))} (${f2(Math.min(...t10))}), n=${clicks10.length}`);
	// median over steps that offered an untried target; the mean over every Jev step (0 when none was offered) is the doc's second number
	const muAll = jevSteps.map((s) => massUntried(P(s), jevByStep.get(s)?.offered, triedBefore(s), agent.offers?.repeat)), mu = muAll.filter(Number.isFinite);
	row("massUntried, median (n with targets) / mean over all", `${withN(median(mu), mu.length)} / ${withN(mean(muAll.map((x) => Number.isFinite(x) ? x : 0)), muAll.length)}`);
	const offeredUntried = jevSteps.filter((s, i) => Number.isFinite(muAll[i]));
	const tookUntried = offeredUntried.filter((s) => { const a = acts[s - 1].action; return (a.kind === "click" || a.kind === "interact") && !triedBefore(s).has(a.path); });
	row("U untried-take", frac(tookUntried.length, offeredUntried.length, "no step offered an untried target"));
	const walks = jevSteps.filter((s) => acts[s - 1].action.kind === "walk");
	row("walks with clicks offered (of walks, of steps)", `${walks.filter((s) => Object.keys(P(s)).some(isTarget)).length} (${walks.length} walks, ${jevSteps.length} steps)`);
	row("lowest-index untried click chosen / multi-click", (() => { const mc = multi.filter((s) => Object.keys(P(s)).filter((id) => id.startsWith("click_")).length > 1 && acts[s - 1].action.kind === "click"); return frac(mc.filter((s) => { const ids = Object.keys(P(s)).filter((id) => id.startsWith("click_")).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))); return argmax(P(s)) === ids[0]; }).length, mc.length, "—"); })());

	// notes vs triage (2.1): strict = bug, lenient = bug or look, per current keyOf
	const verdict = (id) => triage?.findings?.find((f) => f.id === id)?.verdict;
	const notes = (report.notes ?? []).map((n, i) => ({ n, i, key: noteKey(n), v: verdict(`note-${i}`) }));
	if (!triage) row("note precision", "no triage.json");
	else {
		row("note precision strict (bug)", frac(notes.filter((x) => x.v === "bug").length, notes.length, "no notes"));
		row("note precision lenient (bug or look)", frac(notes.filter((x) => x.v === "bug" || x.v === "look").length, notes.length, "no notes"));
		const keys = new Map(); for (const x of notes) keys.set(x.key, [...(keys.get(x.key) ?? []), x.v]);
		row("distinct keys (current keyOf)", `${keys.size}: ${[...keys].map(([k, vs]) => `${k.split(":").pop()} (${mode(vs)} ×${vs.length})`).join("; ")}`);
		row("per key strict / lenient", `${frac([...keys.values()].filter((vs) => vs.includes("bug")).length, keys.size, "no keys")} / ${frac([...keys.values()].filter((vs) => vs.some((v) => v === "bug" || v === "look")).length, keys.size, "no keys")}`);
		const prec = (list, id) => { const vs = list.map((_, i) => verdict(`${id}-${i}`)); return `${frac(vs.filter((v) => v === "bug").length, vs.length, "none")} strict, ${frac(vs.filter((v) => v === "bug" || v === "look").length, vs.length, "none")} lenient`; };
		row("suspect precision", prec(report.suspects ?? [], "suspect"));
		row("stuck precision", prec(report.stuck ?? [], "stuck"));
		const bugSteps = [...notes.filter((x) => x.v === "bug").map((x) => x.n.step), ...(report.suspects ?? []).filter((_, i) => verdict(`suspect-${i}`) === "bug").map((s) => s.step), ...(report.errors ?? []).filter((_, i) => verdict(`error-${i}`) === "bug").map((e) => e.firstStep)];
		r.tBug = bugSteps.length ? Math.min(...bugSteps) : null;
		row("T_bug (first bug-verdict finding)", r.tBug ?? `${N + 1} (censored)${labels?.firstBugStep ? `; labels.firstBugStep ${labels.firstBugStep}` : ""}`);
	}

	// the agent's nouls about the previous action: q_s sits on line s+1 (4.3), so the last step has none
	const bins = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
	const nouls = { ...Object.fromEntries(Object.entries(agent.notes ?? {}).map(([id, n]) => [id, n])), looksWrong: { kind: "wrong" } };
	for (const [id, n] of Object.entries(nouls)) {
		const judged = [...Array(Math.max(N - 1, 0)).keys()].map((i) => i + 1).filter((s) => (!n.after || acts[s - 1].action.kind === n.after) && flags(s + 1)[id] !== undefined);
		const q = judged.map((s) => flags(s + 1)[id]);
		if (!q.length) continue;
		row(`${id} histogram${n.after ? ` after ${n.after}` : ""} ${bins.map(([a, b]) => `${a}-${b > 1 ? 1 : b}`).join(" / ")}`, `${bins.map(([a, b]) => q.filter((x) => x >= a && x < b).length).join(" / ")}, n=${q.length}`);
		// labels.json is keyed by the judged step; class by the note's kind (bug for dead-button)
		const cls = { "dead-button": "bug", exploit: "exploit", confusing: "confusing", wrong: "wrong" }[n.kind] ?? "bug";
		const pairs = judged.map((s) => [flags(s + 1)[id], labels?.steps?.[s]?.[cls]]).filter(([, y]) => y === 0 || y === 1);
		if (!labels) { if (id === Object.keys(nouls)[0]) row("precision/recall/F1/Brier/AUROC vs labels", "no labels.json"); continue; }
		const t = tau(id), pos = pairs.filter(([, y]) => y === 1), neg = pairs.filter(([, y]) => y === 0);
		const TP = pos.filter(([q]) => q >= t).length, FP = neg.filter(([q]) => q >= t).length, FN = pos.length - TP;
		const brier = mean(pairs.map(([q, y]) => (q - y) ** 2));
		if (!pos.length) { row(`${id} vs ${cls}: precision / Brier`, `${frac(TP, TP + FP, "no flags ≥ τ")} / ${withN(brier, pairs.length)}; recall, F1, AUROC: no positives; unmeasurable`); continue; }
		const auroc = pos.reduce((a, [qi]) => a + neg.reduce((b, [qj]) => b + (qi > qj ? 1 : qi === qj ? 0.5 : 0), 0), 0) / (pos.length * neg.length);
		row(`${id} vs ${cls}: precision / recall / F1 / Brier / AUROC`, `${frac(TP, TP + FP, "no flags ≥ τ")} / ${frac(TP, TP + FN)} / ${f2(2 * TP / (2 * TP + FP + FN))} / ${f2(brier)} / ${neg.length ? f2(auroc) : "no negatives"}, n=${pairs.length} (${pos.length} positive)`);
	}

	// coverage: cov(end) from report.gui; the curve needs per-step `seen` on stepsLog (4.1)
	const seen = Object.keys(report.gui?.seen ?? {}).length, clicked = report.gui?.clicked?.length ?? 0;
	row("cov(end) clicked / seen", frac(clicked, seen, "nothing seen"));
	if (report.gui?.hidden) row("gui.hidden / gui.unreachable", `${report.gui.hidden.length} / ${report.gui.unreachable?.length ?? 0}`);
	if (stepsLog.some((l) => Array.isArray(l.seen))) {
		const seenSet = new Set(), triedSet = new Set(), cov = [];
		for (const l of stepsLog) { (l.seen ?? []).forEach((p) => seenSet.add(p)); if (l.action?.path && l.action.kind !== "walk") triedSet.add(l.action.path); cov.push(seenSet.size ? triedSet.size / seenSet.size : 0); }
		row("cov(k) at 10 / 20 / end; covAUC", `${f2(cov[9])} / ${f2(cov[19])} / ${f2(cov.at(-1))}; ${withN(mean(cov), cov.length)}`);
	} else row("cov(k), covAUC", "n/a (stepsLog has no `seen`)");

	// ending: code-side exhausted vs Jev's own done streak
	const exhausted = stepsLog.find((l) => l.exhausted === true || (l.facts && agent.exhausted?.(l.facts)))?.step;
	row("exhaust (first exhausted step) / lateness", exhausted ? `${exhausted} / ${N - exhausted}` : stepsLog.some((l) => l.exhausted !== undefined || l.facts) ? `never in ${N} steps (censored)` : "n/a (stepsLog has no `exhausted`/`facts`)");
	let jevDone = null;
	for (let s = 8; s <= N && !jevDone; s++) if ([s - 2, s - 1, s].every((k) => (flags(k).done ?? 0) >= TAU_DONE)) jevDone = s;
	row("jevDone / jevLateness", jevDone ? `${jevDone} / ${exhausted ? jevDone - exhausted : "—"}` : `censored (max done ${f2(Math.max(...jevSteps.map((s) => flags(s).done ?? 0)))}, n=${jevSteps.length})`);
	if (report.brief) row("steps to task target", "n/a (no machine-readable target; see the brief and report.actions)");

	// cost, calls, latency from the recorded exchanges (cached lines cost nothing)
	const paid = [...jevByStep.values()].filter((l) => !l.cached);
	if (paid.length) row("calls / input tokens / cost / Σ ms", `${paid.length} / ${paid.reduce((a, l) => a + (l.usage?.input_tokens ?? 0), 0)} / $${(paid.reduce((a, l) => a + (l.usage?.input_tokens ?? 0), 0) * PRICE).toFixed(5)} / ${paid.reduce((a, l) => a + (l.ms ?? 0), 0)}`);
	else row("calls / cost / latency", "n/a (no jev.jsonl)");
	const models = new Set([...jevByStep.values()].map((l) => l.model).filter(Boolean));
	if (models.size) row("model(s)", [...models].join(", "));
	return out;
}

async function score(runs) {
	const { AGENTS } = await import(pathToFileURL(path.join(here, "agents.mjs")).href).catch((e) => { console.error(`bench: qa/agents.mjs did not load (${e.message}); agent-specific rows are skipped`); return { AGENTS: {} }; });
	const loaded = runs.map(loadRun);
	for (const r of loaded) { console.log(`## ${r.dir}`); console.log(scoreRun(r, AGENTS).join("\n")); }
	// across runs: triage disagreement on shared keys, and how many sessions never produced a bug verdict
	const triaged = loaded.filter((r) => Array.isArray(r.triage?.findings));   // a triage.json that is {} or [] has no verdicts to compare
	if (triaged.length) console.log(`\n## across runs\n  ${"censored fraction (no bug-verdict finding)".padEnd(44)} ${frac(triaged.filter((r) => r.tBug === null).length, triaged.length, "—")}`);
	const keyVerdicts = (r) => { const m = new Map(); (r.report.notes ?? []).forEach((n, i) => { const v = r.triage.findings.find((f) => f.id === `note-${i}`)?.verdict; if (!v) return; const k = noteKey(n), rank = { bug: 2, look: 1, fine: 0 }; if (!m.has(k) || rank[v] > rank[m.get(k)]) m.set(k, v); }); return m; };
	for (let i = 0; i < triaged.length; i++) for (let j = i + 1; j < triaged.length; j++) {
		const a = keyVerdicts(triaged[i]), b = keyVerdicts(triaged[j]), shared = [...a.keys()].filter((k) => b.has(k));
		console.log(`  ${`triage disagreement ${path.basename(triaged[i].dir)} vs ${path.basename(triaged[j].dir)}`.padEnd(44)} ${frac(shared.filter((k) => a.get(k) !== b.get(k)).length, shared.length, "no shared keys")}${shared.length ? `: ${shared.map((k) => `${k.split(":").pop()} ${a.get(k)}→${b.get(k)}`).join("; ")}` : ""}`);
	}
}

// ---- noise -----------------------------------------------------------------------------------------------
async function noise(run, o) {
	const lines = readJsonl(run, "jev.jsonl").filter((l) => !l.cached && l.answers && l.state && l.questions);
	if (!lines.length) die(`${run}: no non-cached jev.jsonl lines (runs recorded before 4.1 have no jev.jsonl)`);
	const key = apiKey() ?? die("no TypeSafe key (PARLAY_TYPESAFE_API_KEY, ~/.parlay/typesafe-api-key or TYPESAFE_API_KEY)");
	const isNoul = (a) => a && typeof a.noul === "number";
	const pick = new Map(lines.filter((l) => l.answers.next?.probabilities).sort((a, b) => margin(a.answers.next.probabilities) - margin(b.answers.next.probabilities)).slice(0, o.states).map((l) => [l.step, l]));
	for (const l of lines) if (Object.entries(l.answers).some(([q, a]) => isNoul(a) && Math.abs(a.noul - tau(q)) <= 0.05)) pick.set(l.step, l);
	const dir = outDir(o, run, "noise"), log = fs.createWriteStream(path.join(dir, "answers.jsonl"));
	const results = []; let calls = 0, tokens = 0, ms = 0;
	for (const l of [...pick.values()].sort((a, b) => a.step - b.step)) {
		const body = { model: o.model, state: l.state, questions: l.questions }, reps = [];
		for (let r = 0; r < o.repeats; r++) {
			const x = await ask(key, body); calls++; tokens += x.usage?.input_tokens ?? 0; ms += x.ms;
			reps.push(x.answers);
			log.write(JSON.stringify({ step: l.step, repeat: r, model: x.model, usage: x.usage, ms: x.ms, answers: x.answers }) + "\n");
		}
		results.push({ step: l.step, reps });
	}
	console.log(`## noise ${run}\n  states ${results.length} (${results.map((r) => r.step).join(", ")}) × repeats ${o.repeats}; model ${o.model}; ${calls} calls, ${tokens} input tokens, $${(tokens * PRICE).toFixed(5)}, Σ ${ms} ms\n  ${"question".padEnd(14)} ${"sd (mean over states)".padEnd(24)} ${"flip / crossing rate".padEnd(24)} n`);
	for (const q of [...new Set(results.flatMap((r) => Object.keys(r.reps[0] ?? {})))]) {
		const per = results.filter((r) => r.reps.every((a) => a[q]));
		if (!per.length) continue;
		if (isNoul(per[0].reps[0][q])) {
			const sds = per.map((r) => sd(r.reps.map((a) => a[q].noul)));
			// crossing: a repeat on the other side of the threshold from the majority side of its own state
			const cross = per.flatMap((r) => { const v = r.reps.map((a) => a[q].noul >= tau(q)); const maj = v.filter(Boolean).length * 2 >= v.length; return v.map((x) => x !== maj ? 1 : 0); });
			console.log(`  ${q.padEnd(14)} ${f2(mean(sds)).padEnd(24)} ${`${frac(cross.filter(Boolean).length, cross.length, "—")} cross τ=${tau(q)}`.padEnd(24)} ${per.length}×${o.repeats}`);
		} else {
			const sds = per.flatMap((r) => [...new Set(r.reps.flatMap((a) => Object.keys(a[q].probabilities ?? {})))].map((id) => sd(r.reps.map((a) => a[q].probabilities?.[id] ?? 0))));
			const flips = per.flatMap((r) => { const tops = r.reps.map((a) => a[q].choice ?? argmax(a[q].probabilities ?? {})); const maj = mode(tops); return tops.map((t) => t !== maj ? 1 : 0); });
			console.log(`  ${q.padEnd(14)} ${`${f2(mean(sds))} per label`.padEnd(24)} ${`${frac(flips.filter(Boolean).length, flips.length, "—")} top-label flips`.padEnd(24)} ${per.length}×${o.repeats}`);
		}
	}
	log.end();
	console.log(`  answers: ${path.join(dir, "answers.jsonl")}`);
}

// ---- replay ----------------------------------------------------------------------------------------------
// Records every state key a compact()/options()/questions() reads that the rebuilt state does not have, so a
// candidate that depends on a fact the runner never recorded is refused instead of silently seeing undefined.
const PROXY_NOISE = new Set(["toJSON", "then", "constructor", "length"]);
function track(obj, seen, prefix = "") {
	if (!obj || typeof obj !== "object") return obj;
	return new Proxy(obj, { get(t, k) {
		const v = t[k];
		if (typeof k === "string" && !Array.isArray(t) && !(k in t) && !PROXY_NOISE.has(k)) seen.add(prefix + k);
		return v && typeof v === "object" ? track(v, seen, `${prefix}${String(k).replace(/^\d+$/, "#")}.`) : v;
	} });
}

async function replay(runs, o) {
	if (!o.candidate) die("replay needs --candidate qa/variants/<name>.mjs");
	const [policy, shared, agents] = await Promise.all([load("policy-jev.mjs", ["compact", "options", "questions"]), load("shared.mjs", ["filterButtons"]), load("agents.mjs", ["AGENTS"])]);
	const cand = await import(pathToFileURL(path.resolve(o.candidate)).href).catch((e) => die(`candidate ${o.candidate}: ${e.message}`));
	const arms = {
		before: { compact: policy.compact, options: policy.options, questions: policy.questions, filter: shared.filterButtons },
		after: { compact: cand.compact ?? policy.compact, options: cand.options ?? policy.options, questions: cand.questions ?? policy.questions, filter: cand.filter ?? shared.filterButtons },
	};
	const only = o.questions?.split(",").map((s) => s.trim()).filter(Boolean);
	const steps = [], drift = { n: 0, keys: new Set() }, same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	for (const run of runs) {
		const report = readJson(run, "report.json"), lines = readJsonl(run, "jev.jsonl").filter((l) => !l.cached);
		if (!lines.length) die(`${run}: no non-cached jev.jsonl lines`);
		for (const l of lines) {
			if (!l.raw) die(`${run} step ${l.step}: the jev.jsonl line has no raw probe (recorded before 4.1); nothing to rebuild`);
			const history = report.actions.slice(0, l.step - 1), agent = agents.AGENTS[l.raw.agent] ?? agents.AGENTS.explorer;
			const reads = {}, built = { run, step: l.step, tried: new Set(history.map((h) => h.action?.path).filter(Boolean)) };
			for (const [arm, fns] of Object.entries(arms)) {
				const seen = reads[arm] = new Set();
				const state = track({ ...l.raw, client: { ...l.raw.client, buttons: fns.filter(l.raw.client?.buttons ?? [], agent.offers ?? {}).kept } }, seen);
				const opts = fns.options(state, history, agent), st = fns.compact(state, history);
				let qs = fns.questions(opts, agent, state.brief, st.textOnScreen ?? []);   // decide() hands compact()'s text to questions() for the log-only suggests choice
				if (only) qs = Object.fromEntries(Object.entries(qs).filter(([id]) => only.includes(id)));
				built[arm] = { body: { model: o.model, state: st, questions: qs }, offered: Object.fromEntries(Object.entries(opts).map(([id, x]) => [id, { kind: x.action?.kind, path: x.action?.path }])) };
			}
			const extra = [...reads.after].filter((k) => !reads.before.has(k));
			if (extra.length) die(`candidate reads ${extra.join(", ")} at ${run} step ${l.step}, which raw does not record; record it first (4.1) or drop the read`);
			// "recorded" has to mean "replayable": a rebuilt baseline that differs from the recorded body means raw lacks a
			// field compact() reads, or the prompt moved since the recording (compare report.code.promptHash)
			const b = built.before.body;
			if (!same(b.state, l.state) || (!only && !same(b.questions, l.questions))) {
				drift.n++;
				for (const k of new Set([...Object.keys(l.state ?? {}), ...Object.keys(b.state)])) if (!same(l.state?.[k], b.state[k])) drift.keys.add(k);
				if (!only && !same(b.questions, l.questions)) drift.keys.add("questions");
			}
			steps.push(built);
		}
	}
	if (drift.n) console.error(`bench: the rebuilt baseline differs from the recorded body on ${drift.n}/${steps.length} steps (${[...drift.keys].join(", ")}): raw lacks a field the current compact()/questions() reads, or the prompt changed since the recording; the before/after deltas below are still paired, but "before" is not what the run saw`);
	const R = o.repeats ?? (steps.some((s) => s.before.body.questions.next || s.after.body.questions.next) ? 5 : 1);   // R=1 for nouls, R>=5 when next is scored (4.4)
	const key = apiKey() ?? die("no TypeSafe key (PARLAY_TYPESAFE_API_KEY, ~/.parlay/typesafe-api-key or TYPESAFE_API_KEY)");
	const dir = outDir(o, runs[0], "replay"), log = fs.createWriteStream(path.join(dir, "answers.jsonl"));
	const cache = new Map(); let calls = 0, tokens = 0;   // identical bodies (across steps and arms) are asked once per repeat
	for (const s of steps) for (const arm of ["before", "after"]) {
		s[arm].answers = [];
		for (let r = 0; r < R; r++) {
			const text = JSON.stringify(s[arm].body), h = sha(text), k = `${h}#${r}`, meta = { run: s.run, step: s.step, arm, repeat: r, hash: h };
			if (!cache.has(k)) { const x = await ask(key, s[arm].body); calls++; tokens += x.usage?.input_tokens ?? 0; cache.set(k, x.answers); log.write(JSON.stringify({ ...meta, model: x.model, usage: x.usage, ms: x.ms, answers: x.answers }) + "\n"); }
			else log.write(JSON.stringify({ ...meta, reused: true }) + "\n");
			s[arm].answers.push(cache.get(k));
		}
	}
	log.end();
	console.log(`## replay ${runs.join(", ")} vs ${o.candidate}\n  steps ${steps.length}, repeats ${R}, model ${o.model}; ${calls} calls (${steps.length * R * 2 - calls} reused identical bodies), ${tokens} input tokens, $${(tokens * PRICE).toFixed(5)}\n  answers: ${path.join(dir, "answers.jsonl")}`);
	const qids = [...new Set(steps.flatMap((s) => [...Object.keys(s.before.body.questions), ...Object.keys(s.after.body.questions)]))];
	for (const q of qids) {
		const metrics = q === "next"
			? { margin: (a) => margin(a.probabilities ?? {}), "top-1": (a) => top1(a.probabilities ?? {}), entropy: (a) => entropy(a.probabilities ?? {}), massUntried: (a, s, arm) => massUntried(a.probabilities ?? {}, s[arm].offered, s.tried, false) }
			: { noul: (a) => a.noul, [`≥ τ ${tau(q)}`]: (a) => a.noul >= tau(q) ? 1 : 0 };
		const has = (s, arm) => q in s[arm].body.questions && s[arm].answers.every((a) => a[q]);
		const nb = steps.filter((s) => has(s, "before")).length, na = steps.filter((s) => has(s, "after")).length;
		console.log(`\n  ${q} (before n=${nb}, after n=${na}${nb && !na ? "; dropped by the candidate" : !nb && na ? "; added by the candidate" : ""})\n  ${"metric".padEnd(14)} ${"before".padEnd(8)} ${"after".padEnd(8)} ${"Δ".padEnd(8)} ${"n".padEnd(5)} ${"repeat sd".padEnd(10)} CI95 (n≥30)`);
		for (const [name, fn] of Object.entries(metrics)) {
			const val = (s, arm) => s[arm].answers.map((a) => fn(a[q], s, arm)).filter(Number.isFinite);
			const paired = steps.filter((s) => has(s, "before") && has(s, "after")).map((s) => ({ b: val(s, "before"), a: val(s, "after") })).filter((p) => p.b.length && p.a.length);
			const before = mean(steps.filter((s) => has(s, "before")).flatMap((s) => val(s, "before"))), after = mean(steps.filter((s) => has(s, "after")).flatMap((s) => val(s, "after")));
			const d = paired.map((p) => mean(p.a) - mean(p.b));
			const repSd = R > 1 ? Math.sqrt(mean(paired.flatMap((p) => [sd(p.b) ** 2, sd(p.a) ** 2]).filter(Number.isFinite))) : NaN;
			console.log(`  ${name.padEnd(14)} ${f2(before).padEnd(8)} ${f2(after).padEnd(8)} ${(d.length ? (mean(d) >= 0 ? "+" : "") + f2(mean(d)) : "—").padEnd(8)} ${String(d.length).padEnd(5)} ${f2(repSd).padEnd(10)} ${d.length >= 30 ? bootstrap(d) : "—"}`);
		}
	}
}

// ---- main ------------------------------------------------------------------------------------------------
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
	states: { type: "string", default: "15" }, repeats: { type: "string" }, model: { type: "string", default: process.env.PARLAY_QA_JEV_MODEL || "jev-latest" },
	candidate: { type: "string" }, questions: { type: "string" }, out: { type: "string" },
} });
const [cmd, ...runs] = positionals;
const opts = { ...o, states: Number(o.states), repeats: o.repeats === undefined ? undefined : Number(o.repeats) };
if (!runs.length || !["score", "noise", "replay"].includes(cmd)) die("usage: node qa/bench.mjs score <run>... | noise <run> [--states 15] [--repeats 6] [--model m] | replay <run>... --candidate qa/variants/<name>.mjs [--repeats N] [--questions a,b]");
for (const r of runs) if (!fs.existsSync(path.join(r, "report.json"))) die(`${r}: no report.json`);
if (cmd === "score") await score(runs);
else if (cmd === "noise") await noise(runs[0], { ...opts, repeats: opts.repeats ?? 6 });
else await replay(runs, opts);
