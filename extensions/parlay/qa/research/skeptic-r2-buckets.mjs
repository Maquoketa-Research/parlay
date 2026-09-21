// Skeptic 2 of R2 (named buckets instead of numbers). Paired replay: the same facts sent as today's compact()
// (numbers) and as R2's buckets (words), today's done/stuck criteria vs bucket-worded criteria, 3 reps each.
// Facts come from run 2026-09-21T01-00-06 (UI tester, Play With Your Poop) and Exp 5 (empty baseplate).
// Key read from ~/.parlay/typesafe-api-key inside this script, never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "file:///C:/Users/Dave.MAQUOKETA/Documents/GitHub/drydock-ide/extensions/parlay/qa/agents.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const ui = AGENTS.ui;
const TEXT = ["FIRST RUN • 1/4 • YOUR FIRST BIG THROW", "CLOSE PANEL TO CONTINUE", "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "x2 EQUIPPED POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "CORE COLLECTION • TIER 3", "Bronze", "x4 POWER", "x4 EQUIPPED POWER", "7.5K COINS", "NEED 7.5K MORE", "Poop Seat", "PASSES"];
const HUD = ["RobuxButton", "Skip", "ShopBtn", "IndexBtn", "RebirthBtn"];
const delta0 = { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 };
const walks = ["walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"];

// facts → today's numeric state
function numeric(f) {
	return {
		player: { position: [231, 109, 178], health: 100, state: "Running" }, leaderstats: { "Best Distance": 0, Coins: 0 },
		buttonsOnScreen: f.buttons, interactablesNearby: [],
		tried: { buttons: `${f.buttons.length - f.untried} of ${f.buttons.length}`, interactables: "0 of 0" },
		untried: { buttons: f.untried, interactables: 0 },
		stepsSinceAnythingNew: Math.min(f.sinceNew, 5), textOnScreen: f.text, lastActions: f.last, sinceLastAction: delta0,
		lastConsoleLines: [], stepsWithoutChange: Math.min(f.still, 5),
	};
}
// facts → R2's bucketed state (same fields, words instead of numbers)
const when = (n) => n === 0 ? "just now" : n <= 2 ? "a step or two ago" : n <= 4 ? "a few steps ago" : "a while ago (five or more steps)";
const howMany = (n) => n === 0 ? "none" : n <= 3 ? "a few" : "many";
function bucketed(f) {
	const n = f.buttons.length, u = f.untried;
	const tried = n === 0 ? "no buttons on screen" : u === 0 ? "every button on screen tried" : u === n ? "no button tried yet" : u > n / 2 ? "most buttons untried" : "most buttons tried, a few untried";
	return { ...numeric(f), tried: { buttons: tried, interactables: "no interactables" }, untried: { buttons: howMany(u), interactables: "none" }, stepsSinceAnythingNew: when(f.sinceNew), stepsWithoutChange: when(f.still) };
}

const qNum = {
	done: { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: { true: ui.doneWhen, false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } },
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: { true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.", false: "The player moves, the screen or the console changes, or new content is still being reached." } },
};
const qBucket = {
	done: { type: "noul", instructions: qNum.done.instructions, criteria: { true: "untried buttons is none and stepsSinceAnythingNew is a while ago: every button seen has been clicked and no new interface has appeared.", false: "untried buttons is a few or many, or stepsSinceAnythingNew is just now or a step or two ago because a new button, interactable or console line just appeared." } },
	stuck: { type: "noul", instructions: qNum.stuck.instructions, criteria: { true: "stepsWithoutChange is a while ago: the last actions changed nothing, same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.", false: "stepsWithoutChange is just now or a step or two ago: the player moves, the screen or the console changes, or new content is still being reached." } },
};

// [label, facts, truth for done (exhausted()), truth for stuck (still>=5)]
const cases = [
	["end real: HUD 5/5 tried, sinceNew 8, text on", { buttons: HUD, untried: 0, sinceNew: 8, still: 0, text: TEXT, last: ['click "Hit" → ok', 'click "Hit" → ok', ...walks] }, true, false],
	["end real: HUD 5/5 tried, sinceNew 8, text off", { buttons: HUD, untried: 0, sinceNew: 8, still: 0, text: [], last: ['click "Hit" → ok', 'click "Hit" → ok', ...walks] }, true, false],
	["end real: 26/26 tried, sinceNew 8", { buttons: [...HUD, ...Array(21).fill("Hit")], untried: 0, sinceNew: 8, still: 0, text: TEXT, last: ['click "Hit" → ok', 'click "Hit" → ok', ...walks] }, true, false],
	["mid real: 7/26 tried, sinceNew 3", { buttons: [...HUD, ...Array(21).fill("Hit")], untried: 19, sinceNew: 3, still: 0, text: TEXT, last: ['click "Skip" → ok', 'click "RobuxButton" → ok', 'click "CloseButton" → ok', 'click "Hit" → ok', 'click "Hit" → ok'] }, false, false],
	["late real: 25/26 tried, sinceNew 8", { buttons: [...HUD, ...Array(21).fill("Hit")], untried: 1, sinceNew: 8, still: 0, text: TEXT, last: ['click "Hit" → ok', 'click "Hit" → ok', 'click "Hit" → ok', 'click "Hit" → ok', 'click "Hit" → ok'] }, false, false],
	["empty: 0 buttons, sinceNew 5, still 5", { buttons: [], untried: 0, sinceNew: 5, still: 5, text: [], last: [...walks, ...walks.slice(0, 2)] }, false, true],   // exhausted needs 8; still>=5
	["empty: 0 buttons, sinceNew 8, still 8", { buttons: [], untried: 0, sinceNew: 8, still: 8, text: [], last: [...walks, ...walks.slice(0, 2)] }, true, true],
	["empty: 0 buttons, sinceNew 4, still 4", { buttons: [], untried: 0, sinceNew: 4, still: 4, text: [], last: [...walks, ...walks.slice(0, 2)] }, false, false],
	["empty: 0 buttons, sinceNew 1, still 1", { buttons: [], untried: 0, sinceNew: 1, still: 1, text: [], last: [...walks.slice(0, 2)] }, false, false],
];

const r2 = (x) => Math.round(x * 100) / 100;
async function ask(state, questions) {
	const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-latest", state, questions }), signal: AbortSignal.timeout(20000) });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const j = await r.json();
	return { done: r2(j.answers.done.noul), stuck: r2(j.answers.stuck.noul), tokens: j.usage?.input_tokens };
}
const rows = [];
for (const [label, f, doneTruth, stuckTruth] of cases) {
	for (const [arm, state, q] of [["numeric", numeric(f), qNum], ["bucket", bucketed(f), qBucket]]) {
		const d = [], s = []; let tok;
		for (let rep = 0; rep < 3; rep++) { try { const a = await ask(state, q); d.push(a.done); s.push(a.stuck); tok = a.tokens; } catch (e) { d.push(e.message); } }
		rows.push({ label, arm, doneTruth, stuckTruth, done: d, stuck: s, tok });
		console.log(`${label.padEnd(42)} ${arm.padEnd(7)} done[${doneTruth ? "T" : "F"}] ${d.join(" ")}   stuck[${stuckTruth ? "T" : "F"}] ${s.join(" ")}   tokens ${tok}`);
	}
}
// AUC + precision@0.7 per arm per question over the case means (tiny n; reported as-is)
function auc(pairs) { const pos = pairs.filter((p) => p.t), neg = pairs.filter((p) => !p.t); let w = 0; for (const p of pos) for (const q of neg) w += p.v > q.v ? 1 : p.v === q.v ? 0.5 : 0; return pos.length && neg.length ? w / (pos.length * neg.length) : NaN; }
for (const arm of ["numeric", "bucket"]) for (const q of ["done", "stuck"]) {
	const pairs = rows.filter((r) => r.arm === arm).map((r) => ({ t: q === "done" ? r.doneTruth : r.stuckTruth, v: r[q].filter((x) => typeof x === "number").reduce((a, b) => a + b, 0) / r[q].length }));
	const flagged = pairs.filter((p) => p.v >= 0.7), prec = flagged.length ? flagged.filter((p) => p.t).length / flagged.length : NaN, recall = pairs.filter((p) => p.t && p.v >= 0.7).length / pairs.filter((p) => p.t).length;
	console.log(`${arm.padEnd(7)} ${q.padEnd(5)} AUC ${r2(auc(pairs))}  precision@0.7 ${r2(prec)} (${flagged.length} flagged)  recall@0.7 ${r2(recall)}  n=${pairs.length} pos=${pairs.filter((p) => p.t).length}`);
}
fs.writeFileSync(new URL("./skeptic-r2-buckets.results.json", import.meta.url), JSON.stringify(rows, null, "\t"));
