// Skeptic R7: does a code-computed statsDelta line in sinceLastAction move the Breaker's exploit noul? Same two
// states as probe-agents.mjs BR1/BR2, with and without the line, plus a passive-income state the rec does not
// measure. Key read from disk, never printed. Prints only the exploit noul per variant.   node skeptic-r7-probe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const r2 = (x) => Math.round(x * 100) / 100;
const n = AGENTS.breaker.notes.exploit;
const delta = (o = {}) => ({ buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0, ...o });
const base = { player: { position: [30, 3, -55], health: 100, state: "Running" }, buttonsOnScreen: ["Shop"], interactablesNearby: ["ProximityPrompt CoinPrompt at 25 studs"], tried: { buttons: "1 of 1", interactables: "1 of 1" }, untried: { buttons: 0, interactables: 0 }, lastConsoleLines: [], stepsWithoutChange: 0 };

// the rec's exploit criteria: name statsDelta and the last action kind, not magnitude judgement
const recCriteria = { true: "sinceLastAction.statsDelta is present and the last action in lastActions was a walk, a jump or a click on something that is not a buy or claim; or statsDelta names a gain from a prompt far above what the same prompt gave before.", false: "sinceLastAction has no statsDelta, or the last action was a prompt, buy or claim whose gain matches what it gave before." };

const states = {
	"BR1 legit ×5 (today)": [base, { leaderstats: { Coins: 5 }, stepsSinceAnythingNew: 2, textOnScreen: ["Coins: 5", "Collect"], lastActions: ['click "Shop" → ok', "ProximityPrompt CoinPrompt → arrived", "ProximityPrompt CoinPrompt ×5 → arrived"], sinceLastAction: delta({ statsChanged: true, textAdded: ["Coins: 5"], textRemoved: ["Coins: 0"] }) }, n.criteria],
	"BR1 legit ×5 + statsDelta": [base, { leaderstats: { Coins: 5 }, stepsSinceAnythingNew: 2, textOnScreen: ["Coins: 5", "Collect"], lastActions: ['click "Shop" → ok', "ProximityPrompt CoinPrompt → arrived", "ProximityPrompt CoinPrompt ×5 → arrived"], sinceLastAction: delta({ statsChanged: true, statsDelta: "Coins +5 after using CoinPrompt five times; the previous single use of CoinPrompt gave +1", textAdded: ["Coins: 5"], textRemoved: ["Coins: 0"] }) }, recCriteria],
	"BR2 +100 after walk (today)": [base, { leaderstats: { Coins: 105 }, stepsSinceAnythingNew: 3, textOnScreen: ["Coins: 105", "Collect"], lastActions: ["ProximityPrompt CoinPrompt ×5 → arrived", "walk right + jump → walked D 800 ms", "walk forward + jump → walked W 1500 ms"], sinceLastAction: delta({ statsChanged: true, textAdded: ["Coins: 105"], textRemoved: ["Coins: 5"] }) }, n.criteria],
	"BR2 +100 after walk + statsDelta": [base, { leaderstats: { Coins: 105 }, stepsSinceAnythingNew: 3, textOnScreen: ["Coins: 105", "Collect"], lastActions: ["ProximityPrompt CoinPrompt ×5 → arrived", "walk right + jump → walked D 800 ms", "walk forward + jump → walked W 1500 ms"], sinceLastAction: delta({ statsChanged: true, statsDelta: "Coins +100 after a walk; the previous CoinPrompt use gave +1 each", textAdded: ["Coins: 105"], textRemoved: ["Coins: 5"] }) }, recCriteria],
	"BR3 passive +3/step after walk + statsDelta (should be low)": [base, { leaderstats: { Coins: 14 }, stepsSinceAnythingNew: 4, textOnScreen: ["Coins: 14", "Collect"], lastActions: ["walk left + jump → walked A 800 ms", "walk right + jump → walked D 800 ms", "walk forward + jump → walked W 1500 ms"], sinceLastAction: delta({ statsChanged: true, statsDelta: "Coins +3 after a walk; Coins also rose +3 after each of the previous two walks", textAdded: ["Coins: 14"], textRemoved: ["Coins: 11"] }) }, recCriteria],
};
for (const [name, [b, s, criteria]] of Object.entries(states)) {
	const vals = [];
	for (let i = 0; i < 3; i++) {
		try {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", state: { ...b, ...s }, questions: { exploit: { type: "noul", instructions: n.instructions, criteria } } }), signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			vals.push(r2((await r.json()).answers.exploit.noul));
		} catch (e) { vals.push(`FAILED ${e.message}`); }
	}
	console.log(`${name}: exploit ${vals.join(" ")}`);
}
