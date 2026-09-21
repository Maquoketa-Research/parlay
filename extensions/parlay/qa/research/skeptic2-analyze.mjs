// Read-only analysis of recorded QA runs for R2 (sibling-button collapse). Prints numbers only, no key access.
import fs from "node:fs";
import path from "node:path";
const dirs = process.argv.slice(2);
const strip = (p) => String(p ?? "").replace(/\d+/g, "#");
for (const dir of dirs) {
	const r = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
	console.log(`\n===== ${dir}`);
	console.log(`agent=${r.agent} policy=${r.policy} steps=${r.steps} doneBy=${r.doneBy} notes=${r.notes?.length} suspects=${r.suspects?.length} stuck=${r.stuck?.length} errors=${r.errors?.length}`);
	const seen = Object.entries(r.gui?.seen ?? {});
	const groups = new Map();
	for (const [p, t] of seen) { const k = strip(p); if (!groups.has(k)) groups.set(k, { paths: [], texts: new Set() }); groups.get(k).paths.push(p); groups.get(k).texts.add(t); }
	console.log(`gui.seen=${seen.length} buttons, ${groups.size} numbers-stripped groups; clicked=${r.gui?.clicked?.length}`);
	for (const [k, g] of groups) console.log(`  ${g.paths.length.toString().padStart(3)}x ${k}  texts=${[...g.texts].slice(0, 4).join("|")}`);
	const acts = r.actions ?? [];
	const clicks = acts.filter((a) => a.action?.kind === "click");
	const byGroup = new Map();
	for (const a of clicks) { const k = strip(a.action.path); byGroup.set(k, (byGroup.get(k) ?? 0) + 1); }
	console.log(`actions=${acts.length} clicks=${clicks.length} walks=${acts.filter((a) => a.action?.kind === "walk").length} interacts=${acts.filter((a) => a.action?.kind === "interact").length}`);
	console.log("clicks per stripped group:"); for (const [k, n] of [...byGroup].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(3)} ${k}`);
	// first step each group was clicked
	const first = new Map();
	for (const a of clicks) { const k = strip(a.action.path); if (!first.has(k)) first.set(k, a.step); }
	console.log("first click per group (step):", [...first].map(([k, s]) => `${s}:${k.split(".").slice(-2).join(".")}`).join("  "));
	console.log(`groups clicked=${first.size} of ${groups.size}; step at which the last new group was reached=${Math.max(...first.values(), 0)}`);
	// jev stats per step
	console.log("step kind path top1 nOpts conf | flags");
	for (const a of acts) {
		const j = a.action?.jev; if (!j) { console.log(`${a.step} ${a.action?.kind} (no jev) ${a.result}`); continue; }
		const probs = Object.values(j.probabilities ?? {});
		const top1 = Math.max(...probs, 0);
		const nOpts = probs.length;
		const f = j.flags ?? {};
		console.log(`${String(a.step).padStart(3)} ${a.action.kind.padEnd(8)} ${(a.action.path ?? a.action.key ?? "").split(".").slice(-2).join(".").padEnd(22)} top1=${top1.toFixed(2)} n=${String(nOpts).padStart(2)} conf=${Number(j.confidence ?? 0).toFixed(2)} | dead=${(f.deadButton ?? 0).toFixed(2)} wrong=${(f.looksWrong ?? 0).toFixed(2)} done=${(f.done ?? 0).toFixed(2)} noEff=${(f.noEffect ?? 0).toFixed(2)} ${a.result}`);
	}
	const withMany = acts.filter((a) => a.action?.jev && Object.keys(a.action.jev.probabilities ?? {}).length >= 10);
	const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
	console.log(`steps with >=10 options: ${withMany.length}; mean top-1 = ${mean(withMany.map((a) => Math.max(...Object.values(a.action.jev.probabilities)))).toFixed(3)}; conf range ${Math.min(...withMany.map((a) => a.action.jev.confidence)).toFixed(2)}..${Math.max(...withMany.map((a) => a.action.jev.confidence)).toFixed(2)}`);
	const allJev = acts.filter((a) => a.action?.jev);
	console.log(`all jev steps: ${allJev.length}; mean top-1 = ${mean(allJev.map((a) => Math.max(...Object.values(a.action.jev.probabilities)))).toFixed(3)}`);
	// notes and triage
	const tri = fs.existsSync(path.join(dir, "triage.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "triage.json"), "utf8")) : null;
	console.log(`triage.json: ${tri ? JSON.stringify(tri).slice(0, 1500) : "none"}`);
	for (const n of r.notes ?? []) console.log(`  note step ${n.step} ${n.kind} p=${Number(n.probability).toFixed(2)} "${n.text}" path=${n.actionsBefore?.at(-1)?.action?.path}`);
}
