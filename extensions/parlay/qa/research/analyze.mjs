// Per-run Jev statistics from report.json + stepsLog.jsonl (+ triage.json when present). Read-only.
//   node analyze.mjs
import fs from "node:fs";
import path from "node:path";

const GS = "C:/Users/Dave.MAQUOKETA/AppData/Roaming/Parlay/User/globalStorage/maquoketa.parlay-ide/qa";
const TMP = "C:/Users/Dave.MAQUOKETA/.claude/jobs/260ad20a/tmp";
const RUNS = [...fs.readdirSync(GS).map((d) => path.join(GS, d)), path.join(TMP, "qa-live-2"), path.join(TMP, "qa-live-4")];

const r2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const stats = (a) => a.length ? { n: a.length, mean: r2(mean(a)), min: r2(Math.min(...a)), max: r2(Math.max(...a)), ge07: a.filter((x) => x >= 0.7).length, ge08: a.filter((x) => x >= 0.8).length } : null;
const entropy = (p) => { const v = Object.values(p).filter((x) => x > 0); return r2(-v.reduce((s, x) => s + x * Math.log2(x), 0)); };
// Pearson r, for "does the flag track the runner's fact"
const corr = (xs, ys) => { const mx = mean(xs), my = mean(ys); const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0); const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0)), sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0)); return sx && sy ? r2(sxy / (sx * sy)) : NaN; };

for (const dir of RUNS) {
	const rep = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
	const jev = rep.actions.filter((a) => a.action.jev);
	if (!jev.length) { console.log(`\n## ${path.basename(dir)}: no Jev steps (${rep.failure ?? rep.doneBy ?? "?"})`); continue; }
	let steps = [];
	try { steps = fs.readFileSync(path.join(dir, "stepsLog.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { /* none */ }
	const byStep = Object.fromEntries(steps.map((s) => [s.step, s]));
	console.log(`\n## ${path.basename(dir)}  ${rep.studio?.name ?? ""}\n   agent ${rep.agent ?? "explorer"}; steps ${rep.steps}; doneBy ${rep.doneBy ?? "(none)"}; failure ${rep.failure ?? "-"}; buttons seen ${Object.keys(rep.gui.seen).length}, clicked ${rep.gui.clicked.length}; notes ${(rep.notes ?? []).length}; suspects ${(rep.suspects ?? []).length}; stuck ${rep.stuck.length}`);

	// flags over steps
	const flags = {};
	for (const a of jev) for (const [k, v] of Object.entries(a.action.jev.flags ?? {})) (flags[k] ??= []).push(v);
	console.log("   flags:", JSON.stringify(Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, stats(v)]))));
	console.log("   confidence:", JSON.stringify(stats(jev.map((a) => a.action.jev.confidence ?? 0))));

	// the runner's facts, recomputed: position streak (as the runner did at the time: click steps count in the older runs, so
	// use the stepsLog "stuck" boolean where it exists), new console lines, the kind of the previous action
	let lastPos = "", streak = 0;
	const rows = jev.map((a, i) => {
		const s = byStep[a.step] ?? {}, pos = a.position ? JSON.stringify(a.position.map(Math.round)) : null;
		const newLines = (s.newLines ?? []).length;
		streak = pos !== null && pos === lastPos && newLines === 0 ? streak + 1 : 0; lastPos = pos;
		const probs = a.action.jev.probabilities ?? {}, keys = Object.keys(probs);
		const chosen = keys.find((k) => probs[k] === Math.max(...Object.values(probs))) ?? "?";
		const clicks = keys.filter((k) => k.startsWith("click_")).length, interacts = keys.filter((k) => k.startsWith("interact_")).length, walks = keys.filter((k) => k.startsWith("walk_") || k === "explore" || k === "edge").length;
		return { step: a.step, kind: a.action.kind, prevKind: jev[i - 1]?.action.kind, streak, stuckFlag: !!s.stuck, newLines, options: keys.length, clicks, interacts, walks, top1: r2(Math.max(...Object.values(probs), 0)), H: entropy(probs), walkBeatClick: a.action.kind === "walk" && clicks > 0, chosen, f: a.action.jev.flags ?? {}, notes: s.notes ?? [], doneCode: s.done };
	});
	// choice
	const withChoice = rows.filter((r) => r.options > 1);
	console.log(`   choice: options/step mean ${r2(mean(rows.map((r) => r.options)))} (max ${Math.max(...rows.map((r) => r.options))}); steps with >1 option ${withChoice.length}: top-1 mass mean ${r2(mean(withChoice.map((r) => r.top1)))}, entropy mean ${r2(mean(withChoice.map((r) => r.H)))} bits; kinds ${JSON.stringify(rows.reduce((o, r) => (o[r.kind] = (o[r.kind] ?? 0) + 1, o), {}))}; walk chosen while clicks on offer: ${rows.filter((r) => r.walkBeatClick).length} of ${rows.filter((r) => r.clicks > 0).length} steps with clicks on offer`);
	const stepsClicksOffered = rows.filter((r) => r.clicks > 0);
	if (stepsClicksOffered.length) console.log(`   click-option dilution: clicks offered mean ${r2(mean(stepsClicksOffered.map((r) => r.clicks)))}, top-1 when >=10 clicks: ${JSON.stringify(stats(rows.filter((r) => r.clicks >= 10).map((r) => r.top1)))}, confidence when >=10 clicks: ${JSON.stringify(stats(jev.filter((a, i) => rows[i].clicks >= 10).map((a) => a.action.jev.confidence ?? 0)))}`);
	// flags vs facts
	for (const k of Object.keys(flags)) {
		const xs = rows.map((r) => r.f[k] ?? 0);
		const byStuck = { runnerStuck: stats(rows.filter((r) => r.stuckFlag).map((r) => r.f[k])), notStuck: stats(rows.filter((r) => !r.stuckFlag).map((r) => r.f[k])) };
		const byPrev = Object.fromEntries(["click", "walk", "interact"].map((p) => [p, stats(rows.filter((r) => r.prevKind === p).map((r) => r.f[k]))]).filter(([, v]) => v));
		console.log(`   ${k}: r(streak)=${corr(rows.map((r) => r.streak), xs)} r(step)=${corr(rows.map((r) => r.step), xs)} r(newLines)=${corr(rows.map((r) => r.newLines), xs)}; by runner stuck ${JSON.stringify(byStuck)}; by previous action kind ${JSON.stringify(byPrev)}`);
	}
	// done calibration
	const done = rows.map((r) => r.f.done);
	if (done.some((d) => d !== undefined)) {
		const last3 = done.slice(-3).map((d) => r2(d)), codeLast3 = rows.slice(-3).map((r) => r.doneCode);
		console.log(`   done: Jev last 3 ${JSON.stringify(last3)}, code-side last 3 ${JSON.stringify(codeLast3)}, Jev max ${r2(Math.max(...done))}, first step Jev>=0.8: ${rows.find((r) => r.f.done >= 0.8)?.step ?? "never"}, ended by ${rep.doneBy}; untried at end: buttons ${Object.keys(rep.gui.seen).length - rep.gui.clicked.length} of ${Object.keys(rep.gui.seen).length} seen`);
	}
	// notes vs triage
	const notes = rep.notes ?? [];
	if (notes.length) {
		const target = (n) => String(n.actionsBefore?.at(-1)?.action?.path ?? n.text).replace(/\d+/g, "#");
		const uniq = new Set(notes.map(target));
		let tri = null; try { tri = JSON.parse(fs.readFileSync(path.join(dir, "triage.json"), "utf8")); } catch { /* none */ }
		const verdicts = {}; const byTarget = {};
		for (const f of tri?.findings ?? []) { if (!f.id.startsWith("note-")) continue; verdicts[f.verdict] = (verdicts[f.verdict] ?? 0) + 1; const n = notes[Number(f.id.split("-")[1])]; (byTarget[target(n)] ??= new Set()).add(f.verdict); }
		const pos = (verdicts.bug ?? 0) + (verdicts.look ?? 0), tot = Object.values(verdicts).reduce((s, x) => s + x, 0);
		console.log(`   notes: ${notes.length} (${uniq.size} unique targets: ${[...uniq].join(", ")}); Jev prob mean ${r2(mean(notes.map((n) => n.probability)))}; steps flagged where previous action was a walk: ${notes.filter((n) => n.actionsBefore?.at(-1)?.action?.kind === "walk").length}`);
		if (tri) console.log(`   triage (ws ${tri.ws ?? "NONE: no scripts"}): ${JSON.stringify(verdicts)} → precision (bug+look)/all = ${tot ? r2(pos / tot) : "?"} by note; by unique target ${JSON.stringify(Object.fromEntries(Object.entries(byTarget).map(([k, v]) => [k, [...v].join("/")])))}; bugs confirmed ${verdicts.bug ?? 0}`);
	}
	// suspects vs facts
	const sus = rep.suspects ?? [];
	if (sus.length) console.log(`   suspects: ${sus.length} at steps ${sus.map((s) => s.step).join(",")}; runner-stuck at those steps: ${sus.filter((s) => byStep[s.step]?.stuck).length}; console lines then: ${sus.map((s) => (s.console ?? []).length).join(",")}`);
	// per-step compact trail
	console.log("   trail: " + rows.map((r) => `${r.step}${r.kind[0]}${r.stuckFlag ? "!" : ""}${r.notes.length ? "*" : ""}[${r.options}:${r.top1}]`).join(" "));
}
