// Repeatability probe: same frozen state, same questions, N calls, per model id. Prints only response.model,
// choices, probabilities and noul values plus std devs. The key is read from disk and never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const N = 6;

// A state in the shape compact() produces, modelled on step 13 of run 2026-09-21T01-00-06 (UI tester, seven
// identical "Travel" buttons on screen, last click changed nothing) where the recorded top1-top2 margin was 0.04.
const buttons = ["CloseButton", "Travel", "Travel", "Travel", "Travel", "Travel", "Travel", "Travel", "RobuxButton", "Skip"];
const state = {
	player: { position: [211, 109, 189], health: 100, state: "Running" },
	leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: buttons,
	interactablesNearby: [],
	tried: { buttons: "3 of 10", interactables: "0 of 0" },
	untried: { buttons: 7, interactables: 0 },
	stepsSinceAnythingNew: 2,
	textOnScreen: ["Worlds", "World 1", "World 2", "World 3", "World 4", "World 5", "World 6", "Coins: 0"],
	lastActions: ['click "ShopBtn" → ok', 'click "IndexBtn" → ok', 'click "RebirthBtn" → ok', 'click "CloseButton" → ok', 'click "Travel" → ok'],
	sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 },
	lastConsoleLines: [],
	stepsWithoutChange: 1,
};
const opts = {};
buttons.forEach((b, i) => { if (![1, 2, 3].includes(i) && i !== 0) opts[`click_${i}`] = `Click the "${b}" TextButton in ScrollingFrame`; });
opts.explore = "Walk somewhere else to look for more interface";
const questions = {
	next: { type: "choice", instructions: "You are play-testing a Roblox game as the UI tester: Press every button and open every menu; walk only to look for more interface. Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.", criteria: opts },
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: { true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.", false: "The player moves, the screen or the console changes, or new content is still being reached." } },
	noEffect: { type: "noul", instructions: "The last action did not have its intended effect.", criteria: { true: "The last action's outcome says failed, timeout or gave up, or sinceLastAction shows nothing at all after a click or a prompt.", false: "The last action arrived, clicked or walked as intended and sinceLastAction shows something, or there is no last action yet." } },
	looksWrong: { type: "noul", instructions: "Something is broken for a player, beyond the player merely not moving.", criteria: { true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason; the player fell through the floor, or the humanoid state is Dead or Ragdoll without a cause.", false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal; only the console or the states above count as broken." } },
	done: { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: { true: "untried buttons is 0 and stepsSinceAnythingNew is 5 or more: every button seen has been clicked and no new interface has appeared.", false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } },
	deadButton: { type: "noul", instructions: "The last click changed nothing.", criteria: { true: "The last action was a click and sinceLastAction shows nothing: no buttons or text added or removed, stats and health unchanged, no console lines.", false: "The last action was not a click, or sinceLastAction shows a button or text that appeared or vanished, a stat or health change, or console lines." } },
};

const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

// E0b re-run (2026-09-20): pinned arm only. The original also sent "jev-latest" (alias sd) and "jev-1.12.0" (expects
// HTTP 400 Unknown model); both dropped because the audit rule is one pinned model in every request.
for (const model of ["jev-1.13.0"]) {
	const runs = [];
	let status = "";
	for (let i = 0; i < N; i++) {
		const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(20000) });
		if (!r.ok) { status = `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`; break; }
		runs.push(await r.json());
	}
	console.log(`\n== model sent: ${model}${status ? `  -> ${status}` : ""}`);
	if (!runs.length) continue;
	console.log("response.model:", [...new Set(runs.map((r) => r.model))].join(", "), "| calls:", runs.length, "| usage[0]:", JSON.stringify(runs[0].usage));
	const choices = runs.map((r) => r.answers.next.choice);
	console.log("next.choice:", choices.join(","), "| flips vs first:", choices.filter((c) => c !== choices[0]).length);
	console.log("next.confidence:", runs.map((r) => r.answers.next.confidence.toFixed(3)).join(","));
	const ids = Object.keys(runs[0].answers.next.probabilities);
	for (const id of ids) console.log(`  p(${id}):`, runs.map((r) => r.answers.next.probabilities[id].toFixed(3)).join(","), "sd", sd(runs.map((r) => r.answers.next.probabilities[id])).toFixed(4));
	for (const q of Object.keys(questions).filter((q) => q !== "next")) { const v = runs.map((r) => r.answers[q].noul); console.log(`  ${q}:`, v.map((x) => x.toFixed(3)).join(","), "sd", sd(v).toFixed(4), "crosses 0.7:", v.some((x) => x >= 0.7) && v.some((x) => x < 0.7)); }
}
