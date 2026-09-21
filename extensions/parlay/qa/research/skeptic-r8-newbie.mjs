// Skeptic R8 (P13 persona / quoting / suggests), written for E0b because the original 11 calls lived only in a transcript.
// State: the R2 step-6..8 screen (POOP SHOP panel open, tutorial banner "CLOSE PANEL TO CONTINUE"), the same one
// probe-agents.mjs NB1 uses; two buttons tried so IndexBtn is still on offer. Options: one per distinct untried
// button text in today's option wording (the transcript's exact option list is not on disk, so numbers may differ).
// Arms, 3 reps each (18 calls):
//   A newbie goal, B explorer goal, C ui goal      -> same state and options, only the goal sentence differs
//   D newbie, banner quoted on CloseButton        -> the code-matched line ("CLOSE PANEL" ~ CloseButton)
//   E newbie, banner quoted on Hit                -> the same trick pointed at a different button
//   F newbie, banner lines removed                -> does `suggests` still name a line when no tutorial text is present
// Every body also carries `suggests` (log-only choice over textOnScreen) and `lost`; questions are independent, so
// they cannot move `next`. Key read from ~/.parlay/typesafe-api-key, never printed.   node skeptic-r8-newbie.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.9ee28b1.mjs";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const r2 = (x) => Math.round(x * 100) / 100;

const BANNER_CLOSE = "CLOSE PANEL TO CONTINUE", BANNER_FIRST = "FIRST RUN • 1/4 • YOUR FIRST BIG THROW";
const TEXT = [BANNER_FIRST, BANNER_CLOSE, "POOP SHOP", "0 COINS • 1/20 COLLECTED", "CORE COLLECTION • TIER 2", "Solid", "x2 POWER", "x2 EQUIPPED POWER", "LOCKED", "500 COINS", "NEED 500 MORE", "SAVE UP", "CORE COLLECTION • TIER 3", "Bronze", "x4 POWER", "x4 EQUIPPED POWER", "7.5K COINS", "NEED 7.5K MORE", "Poop Seat", "PASSES"];
const state = (text = TEXT) => ({
	player: { position: [211, 109, 189], health: 100, state: "Running" }, leaderstats: { "Best Distance": 0, Coins: 0 },
	buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "CloseButton", ...Array(20).fill("Hit")], interactablesNearby: [],
	tried: { buttons: "2 of 24", interactables: "0 of 0" }, untried: { buttons: 22, interactables: 0 }, stepsSinceAnythingNew: 1, textOnScreen: text,
	lastActions: ['click "ShopBtn" → ok', 'click "Hit" → ok'],
	sinceLastAction: { buttonsAdded: [], buttonsRemoved: [], textAdded: [], textRemoved: [], statsChanged: false, healthChanged: false, consoleLines: 0 },
	lastConsoleLines: [], stepsWithoutChange: 0,
});

// today's option wording (policy-jev.mjs options(): Click the "<text>" <class> in <parent>)
const OPTS = {
	click_index: 'Click the "IndexBtn" ImageButton in Rail',
	click_rebirth: 'Click the "RebirthBtn" ImageButton in Rail',
	click_close: 'Click the "CloseButton" TextButton in Panel',
	click_hit: 'Click the "Hit" TextButton in Tier2',
};
const quoted = (id, line) => ({ ...OPTS, [id]: `${OPTS[id]} (the banner says "${line}")` });

const instr = (agent) => `You are play-testing a Roblox game as the ${agent.name}: ${agent.goal} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`;
const questions = (agent, opts, text = TEXT) => ({
	next: { type: "choice", instructions: instr(agent), criteria: opts },
	suggests: { type: "choice", instructions: "Which on-screen text tells a first-time player what to do next?", criteria: Object.fromEntries(text.map((t, i) => [`text_${i}`, t])) },
	lost: { type: "noul", instructions: AGENTS.newbie.notes.lost.instructions, criteria: AGENTS.newbie.notes.lost.criteria },
});

const noBanner = TEXT.filter((t) => t !== BANNER_CLOSE && t !== BANNER_FIRST);
const arms = {
	"A newbie goal": { state: state(), questions: questions(AGENTS.newbie, OPTS) },
	"B explorer goal": { state: state(), questions: questions(AGENTS.explorer, OPTS) },
	"C ui goal": { state: state(), questions: questions(AGENTS.ui, OPTS) },
	"D newbie, CLOSE PANEL banner quoted on CloseButton": { state: state(), questions: questions(AGENTS.newbie, quoted("click_close", BANNER_CLOSE)) },
	"E newbie, FIRST RUN banner quoted on Hit": { state: state(), questions: questions(AGENTS.newbie, quoted("click_hit", BANNER_FIRST)) },
	"F newbie, banner lines removed": { state: state(noBanner), questions: questions(AGENTS.newbie, OPTS, noBanner) },
};

for (const [name, body] of Object.entries(arms)) {
	console.log(`== ${name}`);
	const text = body.state.textOnScreen;
	for (let rep = 1; rep <= 3; rep++) {
		try {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", ...body }), signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const a = (await r.json()).answers;
			const probs = Object.entries(a.next.probabilities).map(([k, v]) => `${k}=${r2(v)}`).join(" ");
			const s = a.suggests, sTop = Object.entries(s.probabilities).sort((x, y) => y[1] - x[1])[0];
			console.log(`  rep ${rep}: next -> ${a.next.choice} conf ${r2(a.next.confidence)} [${probs}] | suggests -> "${text[Number(sTop[0].slice(5))]}" ${r2(sTop[1])} conf ${r2(s.confidence)} | lost ${r2(a.lost.noul)}`);
		} catch (e) { console.log(`  rep ${rep}: FAILED ${e.message}`); }
	}
}
