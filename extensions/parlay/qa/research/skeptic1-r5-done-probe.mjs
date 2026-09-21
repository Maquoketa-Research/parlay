// Skeptic 1 on R5: does "raise the criterion number" work while compact() caps stepsSinceAnythingNew at 5?
// A: today's state (cap 5) + today's criterion ("5 or more")     -> expect ~0.83 (Exp 5)
// B: today's state (cap 5) + criterion "8 or more"               -> the R5 fallback with the cap left alone
// C: state 8 (cap raised) + criterion "8 or more"                -> the fallback done right
// D: real-game end state of run 2026-09-21T01-00-06 + today's q  -> the live run answered 0.07-0.08 here
// Key read from ~/.parlay/typesafe-api-key, never printed. 3 reps each, 12 calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { empty } from "./lib.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const q = (n) => ({ type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: {
	true: `untried buttons is 0 and stepsSinceAnythingNew is ${n} or more: every button seen has been clicked and no new interface has appeared.`,
	false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } });
const TEXT = ["FIRST RUN • 1/4 • YOUR FIRST BIG THROW", "CLOSE PANEL TO CONTINUE", "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "Poop Seat", "PASSES"];
const realEnd = { player: { position: [211, 109, 189], health: 100, state: "Running" }, leaderstats: { "Best Distance": 0, Coins: 0 }, buttonsOnScreen: [], interactablesNearby: [], tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 5, textOnScreen: TEXT, lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"], sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 }, lastConsoleLines: [], stepsWithoutChange: 0 };
const conds = [
	["A cap5 + '5 or more' (today)", empty(5), q(5)],
	["B cap5 + '8 or more' (R5 fallback, cap unchanged)", empty(5), q(8)],
	["C state 8 + '8 or more' (cap raised too)", empty(8), q(8)],
	["D real-game end state + today's q", realEnd, q(5)],
];
const r2 = (x) => Math.round(x * 100) / 100;
for (const [name, state, done] of conds) {
	const vals = [];
	for (let rep = 0; rep < 3; rep++) {
		const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state, questions: { done } }) });
		if (!r.ok) { vals.push(`HTTP ${r.status}`); continue; }
		vals.push(r2((await r.json()).answers.done.noul));
	}
	console.log(`${name}: done ${vals.join(" ")}`);
}
