// Paired live probes against TypeSafe: the same step state with one field changed, to see which fields move a flag.
// The key is read from ~/.parlay/typesafe-api-key inside this script and never printed. ~10 requests, text only.
//   node probe-pairs.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const ui = AGENTS.ui;
const r2 = (x) => Math.round(x * 100) / 100;

// step 8 of run 2026-09-21T01-00-06 (UI tester on Play With Your Poop), rebuilt in compact()'s shape from the
// report, the screenshot and the probes' fields; delta as today's runner sends it (all empty after a dead click)
const TEXT = ["FIRST RUN • 1/4 • YOUR FIRST BIG THROW", "CLOSE PANEL TO CONTINUE", "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "x2 EQUIPPED POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "CORE COLLECTION • TIER 3", "Bronze", "x4 POWER", "x4 EQUIPPED POWER", "7.5K COINS", "NEED 7.5K MORE", "Poop Seat", "PASSES"];
const buttons = ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array.from({ length: 20 }, () => "Hit")];
const base = {
	player: { position: [211, 109, 189], health: 100, state: "Running" },
	leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: buttons,
	interactablesNearby: [],
	tried: { buttons: "7 of 26", interactables: "0 of 0" },
	untried: { buttons: 19, interactables: 0 },
	stepsSinceAnythingNew: 3,
	textOnScreen: TEXT,
	lastActions: ['click "Skip" → ok', 'click "RobuxButton" → ok', 'click "CloseButton" → ok', 'click "Hit" → ok', 'click "Hit" → ok'],
	sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 },
	lastConsoleLines: [],
	stepsWithoutChange: 0,
};
const Q = {
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: { true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.", false: "The player moves, the screen or the console changes, or new content is still being reached." } },
	noEffect: { type: "noul", instructions: "The last action did not have its intended effect.", criteria: { true: "The last action's outcome says failed, timeout or gave up, or sinceLastAction shows nothing at all after a click or a prompt.", false: "The last action arrived, clicked or walked as intended and sinceLastAction shows something, or there is no last action yet." } },
	done: { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: { true: ui.doneWhen, false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } },
	deadButton: { type: "noul", instructions: ui.notes.deadButton.instructions, criteria: ui.notes.deadButton.criteria },
};
// the variant question a task-specific UI tester would ask: a disabled or locked button that does nothing is not dead
const deadButton2 = { type: "noul", instructions: "The last click changed nothing although the button was enabled and meant to do something.", criteria: {
	true: "The last action was a click on a button that is interactable and not labelled locked, disabled, or save up, and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.",
	false: "The last action was not a click; or the clicked button is not interactable, or its label or the text next to it says locked, disabled, need more or save up; or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } };

async function ask(state, questions) {
	const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state, questions }), signal: AbortSignal.timeout(20000) });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const j = await r.json();
	return j.answers;   // raw, so the choice line below can read probabilities from the same call (no re-ask)
}

const pairs = [
	// A: is deadButton reading sinceLastAction, or the number of unchanged steps? (same empty delta, count 0 vs 5)
	["A1 dead click, stepsWithoutChange 0", base, { deadButton: Q.deadButton, stuck: Q.stuck, noEffect: Q.noEffect }],
	["A2 dead click, stepsWithoutChange 5", { ...base, stepsWithoutChange: 5 }, { deadButton: Q.deadButton, stuck: Q.stuck, noEffect: Q.noEffect }],
	// B: a click that DID change something (text added) - does deadButton drop as the criteria say it should
	["B1 click with textAdded", { ...base, sinceLastAction: { ...base.sinceLastAction, textAdded: ["Not enough coins"] } }, { deadButton: Q.deadButton, noEffect: Q.noEffect }],
	// C: tell Jev the clicked button is locked: (C1) only via a lastClicked fact with today's question, (C2) with the variant question
	["C1 lastClicked interactable=false, today's question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: ["LOCKED", "SAVE UP", "NEED 500 MORE"] } }, { deadButton: Q.deadButton }],
	["C2 lastClicked interactable=false, variant question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: ["LOCKED", "SAVE UP", "NEED 500 MORE"] } }, { deadButton: deadButton2 }],
	["C3 lastClicked interactable=true, no lock labels, variant question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: true, labelsNearby: ["x2 POWER", "500 COINS"] } }, { deadButton: deadButton2 }],
	// D: done at the end of the same run (untried 0, sinceNew 5, walks) with the game's 20 text labels vs without them
	["D1 end state with textOnScreen", { ...base, buttonsOnScreen: [], tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 5, lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"], stepsWithoutChange: 0 }, { done: Q.done }],
	["D2 end state, textOnScreen empty", { ...base, buttonsOnScreen: [], tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 5, textOnScreen: [], lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"], stepsWithoutChange: 0 }, { done: Q.done }],
	["D3 end state, tried '26 of 26' instead of '0 of 0'", { ...base, buttonsOnScreen: [], tried: { buttons: "26 of 26", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 5, lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"], stepsWithoutChange: 0 }, { done: Q.done }],
	// E: the choice among 19 identical "Hit" options plus dedup: does top-1 mass recover when the duplicates collapse to one
	["E1 choice: 19 Hit options + ShopBtn again", base, { next: { type: "choice", instructions: `You are play-testing a Roblox game as the ${ui.name}: ${ui.goal} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`, criteria: Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`click_${i}`, `Click the "Hit" TextButton in Tier${i + 2}`])) } }],
	["E2 choice: 1 Hit option (dedup by name) + explore", base, { next: { type: "choice", instructions: `You are play-testing a Roblox game as the ${ui.name}: ${ui.goal} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`, criteria: { click_0: 'Click the "Hit" TextButton in Tier2 (one of 19 alike, Tier2 to Tier20)', explore: "Walk somewhere else to look for more interface" } } }],
];
for (const [name, state, questions] of pairs) {
	try {
		const a = await ask(state, questions);
		if (a.next !== undefined) {
			// E0b: the original re-asked here to get probabilities (2 calls per E row); one call now carries both
			const p = a.next.probabilities; const top = Math.max(...Object.values(p));
			console.log(`${name}: choice ${a.next.choice} conf ${r2(a.next.confidence)} top-1 ${r2(top)} options ${Object.keys(p).length}`);
		} else console.log(`${name}: ${JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, r2(v.noul)])))}`);
	} catch (e) { console.log(`${name}: FAILED ${e.message}`); }
}
