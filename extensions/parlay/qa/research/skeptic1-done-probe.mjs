// Skeptic 1 replication of probe-pairs D1/D2/D3 (done noul at the end of run 2026-09-21T01-00-06) with 3 reps,
// plus the integer-field variants R3 proposes. Key read from ~/.parlay/typesafe-api-key, never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const ui = AGENTS.ui;
const TEXT = ["FIRST RUN • 1/4 • YOUR FIRST BIG THROW", "CLOSE PANEL TO CONTINUE", "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "x2 EQUIPPED POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "CORE COLLECTION • TIER 3", "Bronze", "x4 POWER", "x4 EQUIPPED POWER", "7.5K COINS", "NEED 7.5K MORE", "Poop Seat", "PASSES"];
const end = {
	player: { position: [211, 109, 189], health: 100, state: "Running" },
	leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: [],
	interactablesNearby: [],
	stepsSinceAnythingNew: 5,
	textOnScreen: TEXT,
	lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"],
	sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 },
	lastConsoleLines: [],
	stepsWithoutChange: 0,
};
const done = { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: { true: ui.doneWhen, false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } };
const doneEver = { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: { true: "untried is 0 and everTried equals everSeen and stepsSinceAnythingNew is 5 or more: every button ever seen has been clicked and no new interface has appeared.", false: "untried is above 0, or everTried is below everSeen (buttons seen in a menu were never clicked), or stepsSinceAnythingNew is small." } };
const conds = [
	["D1 tried '0 of 0' + text (today's compact)", { ...end, tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 } }, done],
	["D2 tried '0 of 0', no text", { ...end, textOnScreen: [], tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 } }, done],
	["D3 tried '26 of 26' + text", { ...end, tried: { buttons: "26 of 26", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 } }, done],
	["R3a integers everSeen 26 everTried 26, today's done q", { ...end, untried: { buttons: 0, interactables: 0 }, everSeen: { buttons: 26, interactables: 0 }, everTried: { buttons: 26, interactables: 0 } }, done],
	["R3b integers everSeen 34 everTried 26 (8 hidden untried), today's done q", { ...end, untried: { buttons: 0, interactables: 0 }, everSeen: { buttons: 34, interactables: 0 }, everTried: { buttons: 26, interactables: 0 } }, done],
	["R3c integers everSeen 34 everTried 26, done q mentions everTried<everSeen", { ...end, untried: { buttons: 0, interactables: 0 }, everSeen: { buttons: 34, interactables: 0 }, everTried: { buttons: 26, interactables: 0 } }, doneEver],
	["R3d integers everSeen 26 everTried 26, done q mentions everTried<everSeen", { ...end, untried: { buttons: 0, interactables: 0 }, everSeen: { buttons: 26, interactables: 0 }, everTried: { buttons: 26, interactables: 0 } }, doneEver],
	["R3e integers, untried.hidden 8 as its own field, today's done q", { ...end, untried: { buttons: 0, hiddenButtons: 8, interactables: 0 } }, done],
];
const r2 = (x) => Math.round(x * 100) / 100;
for (const [name, state, q] of conds) {
	const vals = [];
	for (let rep = 0; rep < 3; rep++) {
		const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state, questions: { done: q } }) });
		if (!r.ok) { vals.push(`HTTP ${r.status}`); continue; }
		const j = await r.json(); vals.push(r2(j.answers.done.noul));
	}
	console.log(`${name}: done ${vals.join(" ")}`);
}
