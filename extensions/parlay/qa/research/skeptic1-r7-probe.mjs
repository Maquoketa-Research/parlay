// Skeptic 1 on R7. Reuses the exp7 state. Tests the two confounds in Exp 7/7b and the rec's option B.
//   V0 exp7 brief as recorded (replication)
//   V1 brief that literally names the target ("press Hit in Tier 1 of the Shop"), appended to the instruction as today
//   V2 V1 plus ancestry option text (7b)
//   V3 exp7 brief, instruction without the "move somewhere else" clause (confound: stepsWithoutChange 3 + empty delta)
//   V4 exp7 brief + second choice question "Which action advances the task?" (rec option B, plain options)
//   V5 V1 brief + second choice question
// Key read from disk, never printed. Prints probabilities only.   node skeptic1-r7-probe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, "conditions", f), "utf8"));
const r2 = (x) => Math.round(x * 100) / 100;

const plain = load("exp7-brief.json"), anc = load("exp7b-brief+ancestry.json");
const goal = "You are play-testing a Roblox game as the UI tester: Press every button and open every menu; walk only to look for more interface.";
const tail = " Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.";
const tailNoMove = " Pick the next action. Prefer what has not been tried.";
const briefA = "buy the cheapest poop in the shop";
const briefB = "buy the cheapest poop: press Hit in Tier 1 of the Shop";
const instr = (brief, t = tail) => `${goal} Your task from the developer: ${brief}. Work toward it step by step, then keep testing.${t}`;
const taskQ = (brief, criteria) => ({ type: "choice", instructions: `Which action advances the task "${brief}"?`, criteria });

const variants = {
	"V0 exp7 brief (replication)": { state: plain.state, questions: { next: { ...plain.questions.next, instructions: instr(briefA) } } },
	"V1 brief names target, appended to instruction (today's code path)": { state: plain.state, questions: { next: { ...plain.questions.next, instructions: instr(briefB) } } },
	"V2 V1 + ancestry option text": { state: anc.state, questions: { next: { ...anc.questions.next, instructions: instr(briefB) } } },
	"V3 exp7 brief, no 'move somewhere else' clause": { state: plain.state, questions: { next: { ...plain.questions.next, instructions: instr(briefA, tailNoMove) } } },
	"V4 exp7 brief + task question (rec option B)": { state: plain.state, questions: { next: { ...plain.questions.next, instructions: instr(briefA) }, task: taskQ(briefA, plain.questions.next.criteria) } },
	"V5 V1 brief + task question": { state: plain.state, questions: { next: { ...plain.questions.next, instructions: instr(briefB) }, task: taskQ(briefB, plain.questions.next.criteria) } },
};

for (const [name, body] of Object.entries(variants)) {
	console.log(`== ${name}`);
	for (let i = 0; i < 3; i++) {
		try {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", ...body }), signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const a = (await r.json()).answers;
			const fmt = (q) => `${q.choice} conf ${r2(q.confidence)} P(click_9 Hit Tier1)=${r2(q.probabilities.click_9 ?? 0)} P(click_10 Hit Tier2)=${r2(q.probabilities.click_10 ?? 0)} P(click_5 Close)=${r2(q.probabilities.click_5 ?? 0)} P(explore)=${r2(q.probabilities.explore ?? 0)}`;
			console.log(`  rep ${i + 1}: next -> ${fmt(a.next)}${a.task ? ` | task -> ${fmt(a.task)}` : ""}`);
		} catch (e) { console.log(`  rep ${i + 1}: FAILED ${e.message}`); }
	}
}
