// node experiments.mjs 1 2 ... 8   (no args = all). Each experiment prints a markdown table and appends to tables.md.
import { trial, table, stats, step1, step6, empty, OPTS15, NOTHING, Q, UI_NEXT, UI_GOAL, nouls, r2 } from "./lib.mjs";

const REPS = 3;
const EXPLORE = "Walk somewhere else to look for more interface";
const opts = (n, explore = true) => { const o = Object.fromEntries(OPTS15.slice(0, n).map((t, i) => [`click_${i}`, t])); if (explore) o.explore = EXPLORE; return o; };
const choice = (a, id = "next") => { const c = a[id]; const p = c.probabilities; const best = Object.entries(p).filter(([k]) => k !== "explore").sort((x, y) => y[1] - x[1])[0]; return { choice: c.choice, confidence: r2(c.confidence), pExplore: r2(p.explore ?? 0), bestButton: best?.[0], pBest: r2(best?.[1] ?? 0) }; };

const EXP = {
	// 1. argmax dilution: identical state, 2 / 6 / 15 specific buttons + one explore.
	async 1() {
		const rows = [];
		for (const n of [2, 6, 15]) rows.push(...await trial("exp1", `${n}buttons+explore`, { model: "jev-latest", state: step1(), questions: { next: Q.next(opts(n)) } }, REPS, choice));
		table("Exp 1: argmax dilution (state = step1, 15 untried buttons on screen; options vary)", rows);
	},
	// 1b. the real shape of the failure: N near-identical "Hit" options + explore, after the distinctive buttons were used.
	async "1b"() {
		const rows = [];
		for (const n of [2, 6, 12]) {
			const hits = Array.from({ length: n }, (_, i) => [`click_${i + 6}`, `Click the "Hit" TextButton in Tier${i + 1}`]);
			const state = step6({ buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array(n).fill("Hit")], tried: { buttons: `6 of ${6 + n}`, interactables: "0 of 0" }, untried: { buttons: n, interactables: 0 }, lastActions: ['click "IndexBtn" → ok', 'click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok', 'click "CloseButton" → ok'] });
			rows.push(...await trial("exp1b", `${n}hits+explore`, { model: "jev-latest", state, questions: { next: Q.next({ ...Object.fromEntries(hits), explore: EXPLORE }) } }, REPS, choice));
		}
		table("Exp 1b: dilution with near-identical options (6 distinct buttons tried, N 'Hit in TierN' untried + explore)", rows);
	},
	// 1d. position bias: the 12-Hit condition of 1b with the criteria listed in reverse order (Tier12 first).
	async "1d"() {
		const n = 12, hits = Array.from({ length: n }, (_, i) => [`click_${i + 6}`, `Click the "Hit" TextButton in Tier${i + 1}`]).reverse();
		const state = step6({ buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array(n).fill("Hit")], tried: { buttons: `6 of ${6 + n}`, interactables: "0 of 0" }, untried: { buttons: n, interactables: 0 }, lastActions: ['click "IndexBtn" → ok', 'click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok', 'click "CloseButton" → ok'] });
		table("Exp 1d: 12 Hit options listed Tier12 first (position vs content)", await trial("exp1d", "12hits-reversed", { model: "jev-latest", state, questions: { next: Q.next({ ...Object.fromEntries(hits), explore: EXPLORE }) } }, REPS, choice));
	},
	// 1c. step 16 of the recorded run: three dead Hit clicks and two walks changed nothing; the instruction's
	// "when the last actions changed nothing, move somewhere else" clause on vs off.
	async "1c"() {
		const hits = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`click_${i + 6}`, `Click the "Hit" TextButton in Tier${i + 4}`]));
		const state = step6({ buttonsOnScreen: ["ShopBtn", "IndexBtn", "RebirthBtn", "Skip", "RobuxButton", "CloseButton", ...Array(15).fill("Hit")], tried: { buttons: "9 of 21", interactables: "0 of 0" }, untried: { buttons: 12, interactables: 0 }, stepsSinceAnythingNew: 5, stepsWithoutChange: 5, lastActions: ['click "Hit" → ok', 'click "Hit" → ok', 'click "Hit" → ok', 'walk left + jump → ok', 'walk right + jump → ok'] });
		const withClause = UI_NEXT, noClause = `You are play-testing a Roblox game as the UI tester: ${UI_GOAL} Pick the next action. Prefer what has not been tried.`;
		const rows = [];
		rows.push(...await trial("exp1c", "moveClause", { model: "jev-latest", state, questions: { next: Q.next({ ...hits, explore: EXPLORE }, withClause) } }, REPS, choice));
		rows.push(...await trial("exp1c", "noMoveClause", { model: "jev-latest", state, questions: { next: Q.next({ ...hits, explore: EXPLORE }, noClause) } }, REPS, choice));
		table("Exp 1c: 'move somewhere else' clause on/off (12 Hit options + explore, last 5 actions changed nothing)", rows);
	},
	// 2. state format: the same facts as JSON, prose, key: value.
	async 2() {
		const s = step6();
		const prose = `The player is at position ${s.player.position.join(", ")} with ${s.player.health} health, humanoid state ${s.player.state}. Leaderstats: Best Distance 0, Coins 0. Buttons on screen: ${s.buttonsOnScreen.join(", ")}. No interactables nearby. Tried 5 of 26 buttons, 0 of 0 interactables; 21 buttons untried, 0 interactables untried. Steps since anything new: ${s.stepsSinceAnythingNew}. Text on screen: ${s.textOnScreen.join("; ")}. Last actions: ${s.lastActions.join("; ")}. Since the last action: no buttons added or removed, no text added or removed, stats unchanged, health unchanged, 0 console lines. Last console lines: ${s.lastConsoleLines.join("; ")}. Steps without change: ${s.stepsWithoutChange}.`;
		const kv = [
			`player.position: ${s.player.position.join(", ")}`, `player.health: ${s.player.health}`, `player.state: ${s.player.state}`,
			"leaderstats.Best Distance: 0", "leaderstats.Coins: 0", `buttonsOnScreen: ${s.buttonsOnScreen.join(", ")}`, "interactablesNearby: none",
			"tried.buttons: 5 of 26", "tried.interactables: 0 of 0", "untried.buttons: 21", "untried.interactables: 0", `stepsSinceAnythingNew: ${s.stepsSinceAnythingNew}`,
			`textOnScreen: ${s.textOnScreen.join("; ")}`, `lastActions: ${s.lastActions.join("; ")}`,
			"sinceLastAction.buttonsAdded: none", "sinceLastAction.buttonsRemoved: none", "sinceLastAction.textAdded: none", "sinceLastAction.textRemoved: none",
			"sinceLastAction.statsChanged: false", "sinceLastAction.healthChanged: false", "sinceLastAction.consoleLines: 0",
			`lastConsoleLines: ${s.lastConsoleLines.join("; ")}`, `stepsWithoutChange: ${s.stepsWithoutChange}`,
		].join("\n");
		const qs = { stuck: Q.stuck, noEffect: Q.noEffect, looksWrong: Q.looksWrong, done: Q.done, deadButton: Q.deadButton };
		const pick = (a) => nouls(a, Object.keys(qs));
		const rows = [];
		for (const [label, state] of [["json", s], ["prose", prose], ["kv", kv]]) rows.push(...await trial("exp2", label, { model: "jev-latest", state, questions: qs }, REPS, pick));
		table("Exp 2: state format (step6 facts: RobuxButton just clicked, nothing changed)", rows);
	},
	// 3. delta vs snapshot: deadButton with no diff / empty diff / a title changed / a panel opened.
	async 3() {
		const qs = { deadButton: Q.deadButton, noEffect: Q.noEffect, looksWrong: Q.looksWrong };
		const pick = (a) => nouls(a, Object.keys(qs));
		const conds = {
			noDelta: step6({ sinceLastAction: undefined }),
			emptyDelta: step6(),
			titleChanged: step6({ sinceLastAction: { ...NOTHING, textAdded: ["Game Passes"], textRemoved: ["Shop"] }, textOnScreen: ["Coins 0", "Best Distance 0", "Game Passes", "Worlds", "Tier 1", "Tier 2", "Tier 3", "Skip tutorial", "Walk to the toilet"] }),
			panelOpened: step6({ sinceLastAction: { ...NOTHING, buttonsAdded: ["Buy 2x Coins", "CloseButton"], textAdded: ["Game Passes", "2x Coins - 99 R$"], textRemoved: ["Shop"] }, buttonsOnScreen: [...step6().buttonsOnScreen, "Buy 2x Coins", "CloseButton"], tried: { buttons: "5 of 28", interactables: "0 of 0" }, untried: { buttons: 23, interactables: 0 }, stepsSinceAnythingNew: 0 }),
		};
		const rows = [];
		for (const [label, state] of Object.entries(conds)) rows.push(...await trial("exp3", label, { model: "jev-latest", state, questions: qs }, REPS, pick));
		table("Exp 3: delta vs snapshot (last action click RobuxButton → ok)", rows);
	},
	// 4. verdict leakage: raw count 5 vs raw count 5 + stuck:true vs raw count 0.
	async 4() {
		const qs = { stuck: Q.stuck, looksWrong: Q.looksWrong, noEffect: Q.noEffect };
		const pick = (a) => nouls(a, Object.keys(qs));
		const rows = [];
		rows.push(...await trial("exp4", "count5", { model: "jev-latest", state: step6({ stepsWithoutChange: 5 }), questions: qs }, REPS, pick));
		rows.push(...await trial("exp4", "count5+stuckTrue", { model: "jev-latest", state: step6({ stepsWithoutChange: 5, stuck: true }), questions: qs }, REPS, pick));
		rows.push(...await trial("exp4", "count0", { model: "jev-latest", state: step6({ stepsWithoutChange: 0 }), questions: qs }, REPS, pick));
		table("Exp 4: verdict leakage (step6 facts, no console error; only stepsWithoutChange / stuck key vary)", rows);
	},
	// 5. done calibration: ui agent's done on an empty place, untried 0, stepsSinceAnythingNew 0..5.
	async 5() {
		const rows = [];
		for (let k = 0; k <= 5; k++) rows.push(...await trial("exp5", `sinceNew${k}`, { model: "jev-latest", state: empty(k), questions: { done: Q.done } }, REPS, (a) => nouls(a, ["done"])));
		table("Exp 5: done calibration (empty baseplate, 0 buttons, untried 0)", rows);
	},
	// 6. determinism: the full real-shaped request, five times.
	async 6() {
		const criteria = Object.fromEntries(OPTS15.slice(5).map((t, i) => [`click_${i + 5}`, t]));   // the 10 untried at step 6 (first five clicked)
		const body = { model: "jev-latest", state: step6({ buttonsOnScreen: OPTS15.map((t) => t.match(/"([^"]+)"/)[1]), tried: { buttons: "5 of 15", interactables: "0 of 0" }, untried: { buttons: 10, interactables: 0 } }), questions: { next: Q.next(criteria), stuck: Q.stuck, noEffect: Q.noEffect, looksWrong: Q.looksWrong, done: Q.done, deadButton: Q.deadButton } };
		const rows = await trial("exp6", "same", body, 5, (a) => ({ ...choice(a), ...nouls(a, ["stuck", "noEffect", "looksWrong", "done", "deadButton"]) }));
		table("Exp 6: determinism (identical request ×5: step6 state, 10 button options, 5 nouls)", rows);
	},
	// 7. instruction wording on the same options: generic bug-hunt vs the ui goal vs a developer brief.
	async 7() {
		const criteria = Object.fromEntries(OPTS15.slice(5, 11).map((t, i) => [`click_${i + 5}`, t]));   // CloseButton, Travel×3, Hit Tier1, Hit Tier2
		criteria.explore = EXPLORE;
		const state = step6({ buttonsOnScreen: OPTS15.map((t) => t.match(/"([^"]+)"/)[1]), tried: { buttons: "5 of 15", interactables: "0 of 0" }, untried: { buttons: 10, interactables: 0 } });
		const wordings = {
			genericBug: "Pick the next action most likely to reveal a bug.",
			uiGoal: UI_NEXT,
			brief: `You are play-testing a Roblox game as the UI tester: ${UI_GOAL} Your task from the developer: buy the cheapest poop in the shop. Work toward it step by step, then keep testing. Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`,
		};
		const rows = [];
		for (const [label, instructions] of Object.entries(wordings)) rows.push(...await trial("exp7", label, { model: "jev-latest", state, questions: { next: Q.next(criteria, instructions) } }, REPS, choice));
		table("Exp 7: instruction wording (step6 state; options CloseButton, Travel W1-3, Hit Tier1-2, explore)", rows);
	},
	// 7b. same brief, option text carries the two path ancestors (Shop > Tier1) the runner already has.
	async "7b"() {
		const criteria = { click_5: 'Click the "CloseButton" TextButton in Shop > Panel', click_6: 'Click the "Travel" TextButton in Worlds > World1', click_7: 'Click the "Travel" TextButton in Worlds > World2', click_8: 'Click the "Travel" TextButton in Worlds > World3', click_9: 'Click the "Hit" TextButton in Shop > Tier1', click_10: 'Click the "Hit" TextButton in Shop > Tier2', explore: EXPLORE };
		const state = step6({ buttonsOnScreen: OPTS15.map((t) => t.match(/"([^"]+)"/)[1]), tried: { buttons: "5 of 15", interactables: "0 of 0" }, untried: { buttons: 10, interactables: 0 } });
		const brief = `You are play-testing a Roblox game as the UI tester: ${UI_GOAL} Your task from the developer: buy the cheapest poop in the shop. Work toward it step by step, then keep testing. Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`;
		table("Exp 7b: brief + option text with panel ancestry (Shop > Tier1)", await trial("exp7b", "brief+ancestry", { model: "jev-latest", state, questions: { next: Q.next(criteria, brief) } }, REPS, choice));
	},
	// 8. score: one 1-5 "how broken" score vs three nouls, on four scenarios of rising severity.
	async 8() {
		const LEVELS = ["Nothing is wrong: the last action did what it should", "A cosmetic oddity only", "A button or prompt did nothing when used", "A script error, nil or infinite yield in the console", "Unplayable: the player is dead, fell through the floor or is frozen"];
		const score = { type: "score", instructions: "How broken is the game for a player right now, judging by the last action, sinceLastAction and the console.", criteria: LEVELS };
		const three = { noEffect: Q.noEffect, looksWrong: Q.looksWrong, deadButton: Q.deadButton };
		const scenarios = {
			fine: step6({ lastActions: ['click "IndexBtn" → ok', 'click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok', 'click "ShopBtn" → ok'], sinceLastAction: { ...NOTHING, buttonsAdded: ["CloseButton", "Hit", "Hit", "Hit"], textAdded: ["Shop", "Tier 1", "Tier 2"] }, stepsSinceAnythingNew: 0 }),
			deadButton: step6(),
			consoleError: step6({ lastActions: ['click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok', 'click "ShopBtn" → ok', 'click "Hit" → ok'], sinceLastAction: { ...NOTHING, consoleLines: 2 }, lastConsoleLines: ["ServerScriptService.Shop.Buy:105: attempt to index nil with 'X'", "Stack Begin", "Script 'ServerScriptService.Shop.Buy', Line 105 - function buy", "Stack End", "Infinite yield possible on 'ReplicatedStorage:WaitForChild(\"Missing\")'"] }),
			dead: step6({ player: { position: [211, -180, 189], health: 0, state: "Dead" }, lastActions: ['click "RebirthBtn" → ok', 'click "Skip" → ok', 'click "RobuxButton" → ok', 'click "ShopBtn" → ok', 'click "Travel" → ok'], sinceLastAction: { ...NOTHING, healthChanged: true, buttonsRemoved: ["Travel", "Travel", "Travel", "CloseButton"] }, stepsWithoutChange: 0 }),
		};
		const rows = [];
		for (const [label, state] of Object.entries(scenarios)) {
			rows.push(...await trial("exp8", `${label}-score`, { model: "jev-latest", state, questions: { broken: score } }, REPS, (a) => ({ score: r2(a.broken.score), confidence: r2(a.broken.confidence), pLevels: Object.values(a.broken.probabilities).map(r2).join("/") })));
			rows.push(...await trial("exp8", `${label}-nouls`, { model: "jev-latest", state, questions: three }, REPS, (a) => nouls(a, Object.keys(three))));
		}
		table("Exp 8: score (levels 0 fine / 1 cosmetic / 2 dead button / 3 console error / 4 unplayable) vs three nouls", rows);
	},
};

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXP);
for (const id of ids) { console.log(`\n== experiment ${id}`); await EXP[id](); console.log(`calls so far: ${stats.calls}`); }
