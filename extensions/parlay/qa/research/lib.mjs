// Shared harness for the Jev experiments: one POST per trial, every exchange appended to results.jsonl,
// the exact body of each condition saved under conditions/. The key is read here and never logged.
import fs from "node:fs";
import path from "node:path";

const KEY = fs.readFileSync("C:/Users/Dave.MAQUOKETA/.parlay/typesafe-api-key", "utf8").trim();
export const DIR = "C:/Users/Dave.MAQUOKETA/.claude/jobs/260ad20a/tmp/research";
export const stats = { calls: 0 };

export async function ask(body) {
	const t0 = Date.now();
	const r = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
	});
	stats.calls++;
	const text = await r.text();
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
	const j = JSON.parse(text);
	return { answers: j.answers, model: j.model, usage: j.usage, ms: Date.now() - t0 };
}

// Run one condition `reps` times; pick(answers) flattens what to tabulate.
export async function trial(exp, label, body, reps, pick) {
	fs.writeFileSync(path.join(DIR, "conditions", `${exp}-${label}.json`), JSON.stringify(body, null, 1));
	const rows = [];
	for (let rep = 1; rep <= reps; rep++) {
		const res = await ask(body);
		const row = { exp, label, rep, ms: res.ms, ...pick(res.answers) };
		fs.appendFileSync(path.join(DIR, "results.jsonl"), JSON.stringify({ ...row, model: res.model, usage: res.usage, answers: res.answers }) + "\n");
		rows.push(row);
	}
	return rows;
}

const fmt = (v) => typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v ?? "");
// Markdown: every row, then per-label mean (min..max) for numeric columns.
export function table(title, rows) {
	const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "exp");
	const line = (cells) => `| ${cells.join(" | ")} |`;
	const out = [`\n### ${title}`, line(cols), line(cols.map(() => "---"))];
	for (const r of rows) out.push(line(cols.map((c) => fmt(r[c]))));
	const labels = [...new Set(rows.map((r) => r.label))];
	const num = cols.filter((c) => !["label", "rep"].includes(c) && rows.every((r) => typeof r[c] === "number"));
	out.push("", line(["label", ...num.map((c) => `${c} mean (min..max)`)]), line(["---", ...num.map(() => "---")]));
	for (const l of labels) {
		const rs = rows.filter((r) => r.label === l);
		out.push(line([l, ...num.map((c) => { const v = rs.map((r) => r[c]); return `${fmt(v.reduce((a, b) => a + b, 0) / v.length)} (${fmt(Math.min(...v))}..${fmt(Math.max(...v))})`; })]));
	}
	const md = out.join("\n");
	console.log(md);
	fs.appendFileSync(path.join(DIR, "tables.md"), md + "\n");
	return md;
}

// ---- states, built from the real UI-tester run on "[RELEASE] Play With Your Poop" (2026-09-21T01-00-06):
// position [211,109,189], health 100, Running, leaderstats {Best Distance 0, Coins 0}, 26 buttons seen.
export const BUTTONS26 = ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array(7).fill("Travel"), "CloseButton", ...Array(12).fill("Hit")];
export const NOTHING = { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 };
export const TEXT = ["Coins 0", "Best Distance 0", "Shop", "Worlds", "Tier 1", "Tier 2", "Tier 3", "Skip tutorial", "Walk to the toilet"];
// Step 6 of the real run: five rail/HUD buttons clicked, the last one (RobuxButton) changed nothing. compact() shape.
export const step6 = (over = {}) => ({
	player: { position: [211, 109, 189], health: 100, state: "Running" },
	leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: BUTTONS26,
	interactablesNearby: [],
	tried: { buttons: "5 of 26", interactables: "0 of 0" },
	untried: { buttons: 21, interactables: 0 },
	stepsSinceAnythingNew: 2,
	textOnScreen: TEXT,
	lastActions: ['click "ShopBtn" → ok', 'click "IndexBtn" → ok', 'click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok'],
	sinceLastAction: NOTHING,
	lastConsoleLines: ['[Analytics] (studio, not sent) onboarding Y1ddy step 2 "Walk"'],
	stepsWithoutChange: 3,
	...over,
});
// Step 1: nothing tried yet, 15 distinct buttons on screen (the dilution scenario from the first UI run).
export const OPTS15 = [
	'Click the "ShopBtn" ImageButton in Rail', 'Click the "IndexBtn" ImageButton in Rail', 'Click the "RebirthBtn" ImageButton in Rail',
	'Click the "Skip" TextButton in Tutorial', 'Click the "RobuxButton" ImageButton in Hud', 'Click the "CloseButton" TextButton in Panel',
	'Click the "Travel" TextButton in World1', 'Click the "Travel" TextButton in World2', 'Click the "Travel" TextButton in World3',
	'Click the "Hit" TextButton in Tier1', 'Click the "Hit" TextButton in Tier2', 'Click the "Hit" TextButton in Tier3',
	'Click the "Hit" TextButton in Tier4', 'Click the "Hit" TextButton in Tier5', 'Click the "Hit" TextButton in Tier6',
];
export const BUTTONS15 = OPTS15.map((t) => t.match(/"([^"]+)"/)[1]);
export const step1 = () => ({
	player: { position: [211, 109, 189], health: 100, state: "Running" },
	leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: BUTTONS15,
	interactablesNearby: [],
	tried: { buttons: "0 of 15", interactables: "0 of 0" },
	untried: { buttons: 15, interactables: 0 },
	stepsSinceAnythingNew: 0,
	textOnScreen: TEXT,
	lastActions: [],
	lastConsoleLines: [],
	stepsWithoutChange: 0,
});
// Empty baseplate (Aqua Multi-Place Testing): no interface at all, the player has been walking.
export const empty = (sinceNew) => ({
	player: { position: [12 + 3 * sinceNew, 4, -8 * sinceNew], health: 100, state: "Running" },
	buttonsOnScreen: [],
	interactablesNearby: [],
	tried: { buttons: "0 of 0", interactables: "0 of 0" },
	untried: { buttons: 0, interactables: 0 },
	stepsSinceAnythingNew: sinceNew,
	textOnScreen: [],
	lastActions: ["walk forward + jump → ok", "walk left + jump → ok", "walk forward + jump → ok", "walk right + jump → ok", "walk back + jump → ok"],
	sinceLastAction: NOTHING,
	lastConsoleLines: [],
	stepsWithoutChange: 0,
});

// ---- questions, verbatim from policy-jev.mjs / agents.mjs (ui agent)
export const UI_GOAL = "Press every button and open every menu; walk only to look for more interface.";
export const UI_NEXT = `You are play-testing a Roblox game as the UI tester: ${UI_GOAL} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`;
export const Q = {
	next: (criteria, instructions = UI_NEXT) => ({ type: "choice", instructions, criteria }),
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: {
		true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.",
		false: "The player moves, the screen or the console changes, or new content is still being reached." } },
	noEffect: { type: "noul", instructions: "The last action did not have its intended effect.", criteria: {
		true: "The last action's outcome says failed, timeout or gave up, or sinceLastAction shows nothing at all after a click or a prompt.",
		false: "The last action arrived, clicked or walked as intended and sinceLastAction shows something, or there is no last action yet." } },
	looksWrong: { type: "noul", instructions: "Something is broken for a player, beyond the player merely not moving.", criteria: {
		true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason; the player fell through the floor, or the humanoid state is Dead or Ragdoll without a cause.",
		false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal; only the console or the states above count as broken." } },
	done: { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: {
		true: "untried buttons is 0 and stepsSinceAnythingNew is 5 or more: every button seen has been clicked and no new interface has appeared.",
		false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } },
	deadButton: { type: "noul", instructions: "The last click changed nothing.", criteria: {
		true: "The last action was a click and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.",
		false: "The last action was not a click, or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } },
};
export const nouls = (a, ids) => Object.fromEntries(ids.map((id) => [id, a[id]?.noul]));
export const r2 = (x) => Math.round(x * 100) / 100;
