// Determinism probe: the same body five times, then a paraphrased state, to learn whether N repeats matter for bench.mjs.
// The key is read inside this script and never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const state = {
	player: { position: [12, 3, -40], health: 100, state: "Running" },
	leaderstats: { Poop: 0, Rebirths: 0 },
	buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", "Hit", "Hit", "Hit", "Hit"],
	interactablesNearby: [],
	tried: { buttons: "6 of 10", interactables: "0 of 0" },
	untried: { buttons: 4, interactables: 0 },
	stepsSinceAnythingNew: 3,
	textOnScreen: ["Shop", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Poop: 0"],
	lastActions: ['click "RobuxButton" → ok', 'click "CloseButton" → ok', 'click "Hit" → ok'],
	sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 },
	lastConsoleLines: [],
	stepsWithoutChange: 0,
};
const questions = {
	next: { type: "choice", instructions: "You are play-testing a Roblox game as the UI tester: Press every button and open every menu; walk only to look for more interface. Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.",
		criteria: { click_6: 'Click the "Hit" TextButton in Tier1', click_7: 'Click the "Hit" TextButton in Tier2', click_8: 'Click the "Hit" TextButton in Tier3', click_9: 'Click the "Hit" TextButton in Tier4' } },
	deadButton: { type: "noul", instructions: "The last click changed nothing.", criteria: { true: "The last action was a click and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.", false: "The last action was not a click, or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } },
	looksWrong: { type: "noul", instructions: "Something is broken for a player, beyond the player merely not moving.", criteria: { true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason.", false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal." } },
};
async function ask(body) {
	const t0 = Date.now();
	const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
	const j = await r.json();
	return { ms: Date.now() - t0, status: r.status, model: j.model, usage: j.usage, next: j.answers?.next, deadButton: j.answers?.deadButton?.noul, looksWrong: j.answers?.looksWrong?.noul };
}
const body = { model: "jev-1.13.0", state, questions };
const reps = [];
for (let i = 0; i < 5; i++) reps.push(await ask(body));
console.log("same body x5:");
for (const r of reps) console.log(" ", r.status, r.model, r.ms + "ms", "usage", JSON.stringify(r.usage), "choice", r.next?.choice, "conf", r.next?.confidence, "probs", JSON.stringify(r.next?.probabilities), "dead", r.deadButton, "wrong", r.looksWrong);
// a paraphrase: the same facts, one wording change in the delta key
// E0b re-run: 3 reps here (the ledger's P2 row asked for it; the original was n=1)
const body2 = { ...body, state: { ...state, sinceLastAction: { ...state.sinceLastAction, consoleLines: 1 } } };
for (let i = 0; i < 3; i++) {
	const r2 = await ask(body2);
	console.log("consoleLines 0 -> 1:", "dead", r2.deadButton, "wrong", r2.looksWrong, "choice", r2.next?.choice);
}
// state as a string instead of an object
const body3 = { ...body, state: JSON.stringify(state) };
const r3 = await ask(body3);
console.log("state as JSON string:", "dead", r3.deadButton, "wrong", r3.looksWrong, "choice", r3.next?.choice, "probs", JSON.stringify(r3.next?.probabilities), "usage", JSON.stringify(r3.usage));
