// Skeptic 2 / R1: re-run the audit's C1/C2/C3 dead-button pair live, three reps each, plus controls that separate
// the interactable field from the lock labels and from the criteria change. Key read here, never printed. ~18 calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const ui = AGENTS.ui;
const r2 = (x) => Math.round(x * 100) / 100;

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
const today = { type: "noul", instructions: ui.notes.deadButton.instructions, criteria: ui.notes.deadButton.criteria };
const variant = { type: "noul", instructions: "The last click changed nothing although the button was enabled and meant to do something.", criteria: {
	true: "The last action was a click on a button that is interactable and not labelled locked, disabled, or save up, and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.",
	false: "The last action was not a click; or the clicked button is not interactable, or its label or the text next to it says locked, disabled, need more or save up; or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } };
// the field-only variant: names interactable, says nothing about labels (what R1 would ship once locked buttons are filtered upstream)
const fieldOnly = { type: "noul", instructions: "The last click changed nothing although the button was interactable.", criteria: {
	true: "The last action was a click on a button whose interactable is true, and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.",
	false: "The last action was not a click; or lastClicked.interactable is false; or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } };

const lockLabels = ["LOCKED", "SAVE UP", "NEED 500 MORE"], plainLabels = ["x2 POWER", "500 COINS"];
const cases = [
	["C0 no lastClicked, today's question (the run as recorded)", base, today],
	["C1 interactable=false + lock labels, today's question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: lockLabels } }, today],
	["C2 interactable=false + lock labels, variant question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: lockLabels } }, variant],
	["C3 interactable=true + plain labels, variant question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: true, labelsNearby: plainLabels } }, variant],
	["C4 interactable=false + plain labels, variant question (field alone)", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: plainLabels } }, variant],
	["C5 interactable=true + lock labels, variant question (labels alone)", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: true, labelsNearby: lockLabels } }, variant],
	["C6 interactable=false + plain labels, field-only question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: false, labelsNearby: plainLabels } }, fieldOnly],
	["C7 interactable=true + plain labels, field-only question", { ...base, lastClicked: { text: "Hit", parent: "Tier2", interactable: true, labelsNearby: plainLabels } }, fieldOnly],
];

async function ask(state, q) {
	const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state, questions: { deadButton: q } }), signal: AbortSignal.timeout(20000) });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r2((await r.json()).answers.deadButton.noul);
}
for (const [name, state, q] of cases) {
	const reps = [];
	for (let i = 0; i < 3; i++) { try { reps.push(await ask(state, q)); } catch (e) { reps.push(`ERR ${e.message}`); } }
	console.log(`${name}: deadButton ${reps.join(" / ")}`);
}
