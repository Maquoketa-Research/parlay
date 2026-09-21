// Skeptic 2 on R7, round 2: same exp7 state but with the menu today's options() would actually offer (no explore
// while untried buttons remain), and ancestry produced by a mechanical rule (path segments after the prefix
// shared by every button on screen), not hand-picked "Shop > Tier1". Travel paths are a guess in the same style
// (never clicked in any run, so unlogged). Key read from disk, never printed.   node skeptic2-r7-taskq2.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim();
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const plain = JSON.parse(fs.readFileSync(path.join(here, "conditions", "exp7-brief.json"), "utf8"));
const brief = "buy the cheapest poop in the shop";
const r2 = (x) => Math.round(x * 100) / 100;

// the buttons of that state, with the paths the 2026-09-21 runs logged (Travel guessed)
const P = "LocalPlayer.PlayerGui.App.Hud.";
const buttons = {
	click_0: ["ShopBtn", P + "StudHud.Rail.ShopBtn"], click_1: ["IndexBtn", P + "StudHud.Rail.IndexBtn"], click_2: ["RebirthBtn", P + "StudHud.Rail.RebirthBtn"],
	click_3: ["Skip", P + "Tutorial.Skip"], click_4: ["RobuxButton", P + "RobuxButton"],
	click_5: ["CloseButton", P + "PanelLayer.Shop.StudShopPanel.Panel.CloseButton"],
	click_6: ["Travel", P + "PanelLayer.Worlds.WorldsPanel.Panel.ScrollingFrame.World1.Travel"],
	click_7: ["Travel", P + "PanelLayer.Worlds.WorldsPanel.Panel.ScrollingFrame.World2.Travel"],
	click_8: ["Travel", P + "PanelLayer.Worlds.WorldsPanel.Panel.ScrollingFrame.World3.Travel"],
	click_9: ["Hit", P + "PanelLayer.Shop.StudShopPanel.Panel.ScrollingFrame.Tier1.Hit"],
	click_10: ["Hit", P + "PanelLayer.Shop.StudShopPanel.Panel.ScrollingFrame.Tier2.Hit"],
};
// mechanical ancestry: segments after the prefix every on-screen button shares, leaf dropped
const segs = Object.values(buttons).map(([, p]) => p.split("."));
let common = 0; while (segs.every((s) => s[common] === segs[0][common])) common++;
const anc = (id) => buttons[id][1].split(".").slice(common, -1).join(" > ");
const untriedIds = ["click_5", "click_6", "click_7", "click_8", "click_9", "click_10"];
const mech = Object.fromEntries(untriedIds.map((id) => [id, `Click the "${buttons[id][0]}" TextButton${anc(id) ? ` in ${anc(id)}` : ""}`]));
const plainC = Object.fromEntries(untriedIds.map((id) => [id, plain.questions.next.criteria[id]]));
const without = (c, ...ids) => Object.fromEntries(Object.entries(c).filter(([k]) => !ids.includes(k)));
const taskQ = (criteria) => ({ type: "choice", instructions: `Which action advances the task "${brief}"?`, criteria });
const nextQ = (criteria) => ({ ...plain.questions.next, criteria });
const gone = { ...plain.state, tried: { buttons: "7 of 15", interactables: "0 of 0" }, untried: { buttons: 8, interactables: 0 }, lastActions: [...plain.state.lastActions.slice(1), 'click "Hit" → ok'] };

console.log("mechanical ancestry texts:"); for (const [id, t] of Object.entries(mech)) console.log(`  ${id}: ${t}`);
const variants = {
	"T1' plain, no explore + task": { state: plain.state, questions: { next: nextQ(plainC), task: taskQ(plainC) } },
	"T4 mechanical ancestry, no explore + task": { state: plain.state, questions: { next: nextQ(mech), task: taskQ(mech) } },
	"T3' target gone, plain, no explore + task": { state: gone, questions: { next: nextQ(without(plainC, "click_9", "click_10")), task: taskQ(without(plainC, "click_9", "click_10")) } },
	"T5 target gone, mechanical ancestry, no explore + task": { state: gone, questions: { next: nextQ(without(mech, "click_9", "click_10")), task: taskQ(without(mech, "click_9", "click_10")) } },
};
for (const [name, body] of Object.entries(variants)) {
	console.log(`== ${name}`);
	for (let i = 0; i < 3; i++) {
		try {
			const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-1.13.0", ...body }), signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const a = (await r.json()).answers;
			const top = (q) => Object.entries(q.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k}=${r2(v)}`).join(" ");
			console.log(`  rep ${i + 1}: next -> ${a.next.choice} conf ${r2(a.next.confidence)} [${top(a.next)}] | task -> ${a.task.choice} conf ${r2(a.task.confidence)} [${top(a.task)}]`);
		} catch (e) { console.log(`  rep ${i + 1}: FAILED ${e.message}`); }
	}
}
