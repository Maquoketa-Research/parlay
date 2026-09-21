// Skeptic 2 on R7: does a second choice question "Which action advances the task?" put >= 0.5 on the target
// (Hit in Tier1) where the appended brief (Exp 7) and ancestry text (Exp 7b) did not? Reuses the exp7 states.
// T3: target already tried and off the menu: does the task question still answer with confidence >= 0.5
// (the rec has no off switch, so that answer would override "next" for the rest of the run)?
// Key read from disk, never printed. Prints probabilities only.   node skeptic2-r7-taskq.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, "conditions", f), "utf8"));
const brief = "buy the cheapest poop in the shop";
const r2 = (x) => Math.round(x * 100) / 100;

const plain = load("exp7-brief.json"), anc = load("exp7b-brief+ancestry.json");
const taskQ = (criteria) => ({ type: "choice", instructions: `Which action advances the task "${brief}"?`, criteria });
const without = (c, ...ids) => Object.fromEntries(Object.entries(c).filter(([k]) => !ids.includes(k)));

const variants = {
	"T1 plain options + task question": { state: plain.state, questions: { next: plain.questions.next, task: taskQ(plain.questions.next.criteria) } },
	"T2 ancestry options + task question": { state: anc.state, questions: { next: anc.questions.next, task: taskQ(anc.questions.next.criteria) } },
	"T3 target gone (Hit Tier1/2 tried), task question": { state: { ...plain.state, tried: { buttons: "7 of 15", interactables: "0 of 0" }, untried: { buttons: 8, interactables: 0 }, lastActions: [...plain.state.lastActions.slice(1), 'click "Hit" → ok'] },
		questions: { next: { ...plain.questions.next, criteria: without(plain.questions.next.criteria, "click_9", "click_10") }, task: taskQ(without(plain.questions.next.criteria, "click_9", "click_10")) } },
};

for (const [name, body] of Object.entries(variants)) {
	console.log(`== ${name}`);
	for (let i = 0; i < 3; i++) {
		try {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", ...body }), signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const a = (await r.json()).answers;
			const fmt = (q) => `${q.choice} conf ${r2(q.confidence)} P(click_9 Hit Tier1)=${r2(q.probabilities.click_9 ?? 0)} P(click_5 Close)=${r2(q.probabilities.click_5 ?? 0)} P(explore)=${r2(q.probabilities.explore ?? 0)}`;
			console.log(`  rep ${i + 1}: next -> ${fmt(a.next)} | task -> ${fmt(a.task)}`);
		} catch (e) { console.log(`  rep ${i + 1}: FAILED ${e.message}`); }
	}
}
