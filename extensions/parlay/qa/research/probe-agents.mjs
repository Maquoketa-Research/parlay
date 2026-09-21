// Five more live probes: the full five-question bundle on the end state (does bundling depress "done"?), and the
// Breaker's exploit and the Newbie's lost questions on plausible states, since neither agent has run live yet.
// Key read inside, never printed.   node probe-agents.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const r2 = (x) => Math.round(x * 100) / 100;
const noul = (instructions, criteria) => ({ type: "noul", instructions, criteria });
const TEXT = ["FIRST RUN • 1/4 • YOUR FIRST BIG THROW", "CLOSE PANEL TO CONTINUE", "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "x2 EQUIPPED POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "CORE COLLECTION • TIER 3", "Bronze", "x4 POWER", "x4 EQUIPPED POWER", "7.5K COINS", "NEED 7.5K MORE", "Poop Seat", "PASSES"];
const common = (agent, extra) => ({
	stuck: noul("The player appears stuck.", { true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.", false: "The player moves, the screen or the console changes, or new content is still being reached." }),
	noEffect: noul("The last action did not have its intended effect.", { true: "The last action's outcome says failed, timeout or gave up, or sinceLastAction shows nothing at all after a click or a prompt.", false: "The last action arrived, clicked or walked as intended and sinceLastAction shows something, or there is no last action yet." }),
	looksWrong: noul("Something is broken for a player, beyond the player merely not moving.", { true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason; the player fell through the floor, or the humanoid state is Dead or Ragdoll without a cause.", false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal; only the console or the states above count as broken." }),
	done: noul("This test session is complete; nothing useful is left to try.", { true: agent.doneWhen, false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." }),
	...Object.fromEntries(Object.entries(agent.notes).map(([id, n]) => [id, noul(n.instructions, n.criteria)])),
	...extra,
});
const delta = (o = {}) => ({ buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0, ...o });

const probes = [
	["D4 ui end state, all five questions + explore-only choice", AGENTS.ui, {
		player: { position: [206, 111, 175], health: 100, state: "Running" }, leaderstats: { "Best Distance": 0, Coins: 0 },
		buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array(20).fill("Hit")], interactablesNearby: [],
		tried: { buttons: "26 of 26", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 5, textOnScreen: TEXT,
		lastActions: ['click "Hit" → ok', 'click "Hit" → ok', "walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"],
		sinceLastAction: delta(), lastConsoleLines: [], stepsWithoutChange: 0,
	}, { next: { type: "choice", instructions: `You are play-testing a Roblox game as the UI tester: ${AGENTS.ui.goal} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`, criteria: { explore: "Walk somewhere else to look for more interface" } } }],
	// Breaker: a coin prompt used five times legitimately gave 5 coins. The criteria ask for arithmetic ("far more than one use gives"): expect a false exploit
	["BR1 breaker: spam ×5 on a coin prompt, Coins 0→5 (legit)", AGENTS.breaker, {
		player: { position: [12, 3, -40], health: 100, state: "Running" }, leaderstats: { Coins: 5 },
		buttonsOnScreen: ["Shop"], interactablesNearby: ['ProximityPrompt CoinPrompt at 3 studs'], tried: { buttons: "1 of 1", interactables: "1 of 1" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 2, textOnScreen: ["Coins: 5", "Collect"],
		lastActions: ['click "Shop" → ok', "ProximityPrompt CoinPrompt → arrived", "ProximityPrompt CoinPrompt ×5 → arrived"], sinceLastAction: delta({ statsChanged: true, textAdded: ["Coins: 5"], textRemoved: ["Coins: 0"] }), lastConsoleLines: [], stepsWithoutChange: 0,
	}, {}],
	["BR2 breaker: a walk, Coins 5→105 without a cause", AGENTS.breaker, {
		player: { position: [30, 3, -55], health: 100, state: "Running" }, leaderstats: { Coins: 105 },
		buttonsOnScreen: ["Shop"], interactablesNearby: ['ProximityPrompt CoinPrompt at 25 studs'], tried: { buttons: "1 of 1", interactables: "1 of 1" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 3, textOnScreen: ["Coins: 105", "Collect"],
		lastActions: ["ProximityPrompt CoinPrompt ×5 → arrived", "walk right + jump → walked D 800 ms", "walk forward + jump → walked W 1500 ms"], sinceLastAction: delta({ statsChanged: true, textAdded: ["Coins: 105"], textRemoved: ["Coins: 5"] }), lastConsoleLines: [], stepsWithoutChange: 0,
	}, {}],
	// Newbie: the real game's HUD with a tutorial banner saying what to do (expect lost low), and an empty baseplate after walks (expect lost high)
	["NB1 newbie: real HUD, banner says CLOSE PANEL TO CONTINUE", AGENTS.newbie, {
		player: { position: [211, 109, 189], health: 100, state: "Running" }, leaderstats: { "Best Distance": 0, Coins: 0 },
		buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "CloseButton", ...Array(20).fill("Hit")], interactablesNearby: [], tried: { buttons: "2 of 24", interactables: "0 of 0" }, untried: { buttons: 22, interactables: 0 }, stepsSinceAnythingNew: 1, textOnScreen: TEXT,
		lastActions: ['click "ShopBtn" → ok', 'click "Hit" → ok'], sinceLastAction: delta(), lastConsoleLines: [], stepsWithoutChange: 0,
	}, {}],
	["NB2 newbie: empty baseplate, three aimless walks", AGENTS.newbie, {
		player: { position: [4, 3, 12], health: 100, state: "Running" }, leaderstats: undefined,
		buttonsOnScreen: [], interactablesNearby: [], tried: { buttons: "0 of 0", interactables: "0 of 0" }, untried: { buttons: 0, interactables: 0 }, stepsSinceAnythingNew: 3, textOnScreen: [],
		lastActions: ["walk forward + jump → walked W 1500 ms", "walk left + jump → walked A 1500 ms", "walk back + jump → walked S 1500 ms"], sinceLastAction: delta(), lastConsoleLines: [], stepsWithoutChange: 0,
	}, {}],
];
// E0b re-run: 3 reps per probe (the original was n=1; the ledger asked for 3 on NB1/NB2, and the extra reps on
// D4/BR1/BR2 cost nine calls)
for (const [name, agent, state, extra] of probes) for (let rep = 1; rep <= 3; rep++) {
	try {
		const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state, questions: common(agent, extra) }), signal: AbortSignal.timeout(20000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		console.log(`${name} rep ${rep}: ${JSON.stringify(Object.fromEntries(Object.entries(j.answers).map(([k, v]) => [k, v.type === "noul" ? r2(v.noul) : `${v.choice}@${r2(v.confidence)}`])))} usage ${JSON.stringify(j.usage)}`);
	} catch (e) { console.log(`${name} rep ${rep}: FAILED ${e.message}`); }
}
