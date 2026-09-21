// Jev (TypeSafe's model) as the play policy: the same decide(state, history) → action contract as policy.mjs.
// One POST per step: a "choice" over the concrete actions this code enumerates for the agent (agents.mjs: which
// buttons, interactables and walks are on offer) and yes/no "noul" questions: the player is stuck, the last
// action had no effect, something is broken, the session is done, plus the agent's own (a dead button, an
// exploit, a lost newbie). The answers ride back on action.jev (flags, notes) so the runner records them per
// step, turns a confident "broken" into a suspect, a confident agent question into a note, and three confident
// "done" answers into the end of the session.
// Jev reads text only, is literal and is bad at numbers, so the arithmetic (distances, indices, thresholds) and
// the safety rules (only an offered action, never a visited target unless the agent repeats, walks only when
// stuck) stay here, and the state it sees is small and structured: the runner's stuck verdict is never handed
// to it, only the count of unchanged steps. Any failure falls back to the scripted policy, logged once; 401 and
// 422 turn Jev off for the rest of the run, 429 and 529 are retried twice with backoff. The key never reaches a log.
//   key:      PARLAY_TYPESAFE_API_KEY (what the QA view passes from SecretStorage), else ~/.parlay/typesafe-api-key
//             (one line), else TYPESAFE_API_KEY
//   endpoint: PARLAY_QA_JEV_URL (qa-check.mjs points it at a mock), else https://api.typesafe.ai/v1/systemone
// Response, as verified 2026-09-20 against the live API: { model: "jev-1.13.0" (a pinned version, not the alias
// sent), answers: { <id>: { type: "noul", noul } | { type: "choice", choice, confidence, probabilities } },
// usage }. Option ids round-trip verbatim; underscores (interact_0) are the verified form, so no colons here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./agents.mjs";
import scripted from "./policy.mjs";

const ENDPOINT = process.env.PARLAY_QA_JEV_URL || "https://api.typesafe.ai/v1/systemone";
const WALK = { W: "forward", A: "left", S: "back", D: "right" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), "jev:", ...m);
const describe = (a) => a.kind === "click" ? `click "${a.text ?? ""}"` : a.kind === "interact" ? `${a.class} ${a.path.split(".").pop()}${a.times ? ` ×${a.times}` : ""}` : `walk ${WALK[a.key] ?? a.key}${a.jump ? " + jump" : ""}`;
const randomKey = () => "WASD"[Math.floor(Math.random() * 4)];

function apiKey() {
	if (process.env.PARLAY_TYPESAFE_API_KEY) return process.env.PARLAY_TYPESAFE_API_KEY;
	try { return fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim() || process.env.TYPESAFE_API_KEY; } catch { return process.env.TYPESAFE_API_KEY; }
}

// The actions on offer this step, shaped by the agent: option id → { action (the runner's shape), text (the
// line Jev reads) }. Stuck (five steps changed nothing) offers movement only, whatever the agent, as policy.mjs does.
// Walking is offered only once nothing untried is left (or the agent repeats targets on purpose): with a dozen
// specific buttons against one "explore", Jev's probability mass spreads over the buttons and the single walk
// wins the argmax, so a UI tester ended up wandering past thirteen untried buttons.
function options(state, history, agent) {
	const tried = new Set(history.map((h) => h.action?.path).filter(Boolean));
	const o = agent.offers, out = {};
	const fresh = (p) => o.repeat || !tried.has(p);
	const again = (p) => tried.has(p) ? " again" : "";
	if (!state.stuck) {
		if (o.buttons) (state.client?.buttons ?? []).forEach((b, i) => { if (fresh(b.path)) out[`click_${i}`] = { action: { kind: "click", path: b.path, text: b.text, x: b.x, y: b.y }, text: `Click the "${b.text}" ${b.class ?? "button"}${b.parent ? ` in ${b.parent}` : ""}${again(b.path)}` }; });
		if (o.interactables) (state.server?.interactables ?? []).slice(0, 10).forEach((t, i) => {
			const name = t.text || t.path.split(".").pop(), base = { kind: "interact", path: t.path, class: t.class, position: t.position, distance: t.distance };
			if (fresh(t.path)) out[`interact_${i}`] = { action: base, text: `Walk ${Math.round(t.distance ?? 0)} studs to the ${t.class} "${name}" and use it${again(t.path)}` };
			if (o.spam) out[`spam_${i}`] = { action: { ...base, times: 5 }, text: `Walk to the ${t.class} "${name}" and use it five times as fast as possible` };
		});
	}
	const untried = Object.keys(out).some((k) => !k.startsWith("spam_"));
	const roam = state.stuck || !untried || o.repeat;
	if (roam && (o.walks === true || state.stuck)) for (const [key, dir] of Object.entries(WALK)) out[`walk_${key}`] = { action: { kind: "walk", key, ms: 800, jump: true }, text: `Walk ${dir} for a second and jump` };
	if (o.spam) out.edge = { action: { kind: "walk", key: randomKey(), ms: 4000, jump: true }, text: "Run far in one direction, jumping, to hit a wall or fall off an edge" };
	if (roam) out.explore = { action: { kind: "walk", key: randomKey(), ms: 1500, jump: true }, text: o.walks === "explore" ? "Walk somewhere else to look for more interface" : "Wander in a random direction for longer, jumping, to reach somewhere new" };
	return out;
}

// What Jev sees: rounded numbers, names not paths, the last five actions and console lines, what has been tried.
// No step numbers, so a frozen game produces the same state twice and the cached answer is reused instead of a call.
function compact(state, history) {
	const p = state.server?.player, tried = new Set(history.map((h) => h.action?.path).filter(Boolean));
	const buttons = state.client?.buttons ?? [], near = (state.server?.interactables ?? []).slice(0, 10);
	return {
		player: p ? { position: (p.position ?? []).map(Math.round), health: p.health, state: p.state } : "no player yet",
		leaderstats: state.server?.leaderstats,
		buttonsOnScreen: buttons.map((b) => b.text),
		interactablesNearby: near.map((t) => `${t.class} ${t.path.split(".").pop()} at ${Math.round(t.distance ?? 0)} studs`),
		tried: { buttons: `${buttons.filter((b) => tried.has(b.path)).length} of ${buttons.length}`, interactables: `${near.filter((t) => tried.has(t.path)).length} of ${near.length}` },
		untried: { buttons: buttons.filter((b) => !tried.has(b.path)).length, interactables: near.filter((t) => !tried.has(t.path)).length },
		stepsSinceAnythingNew: Math.min(state.sinceNew ?? 0, 5),   // a new button, interactable or console line resets it; 5 means five or more (so quiet steps look alike and the cache answers them)
		textOnScreen: (state.client?.text ?? []).slice(0, 20),
		lastActions: history.slice(-5).map((h) => `${describe(h.action)} → ${h.result ?? "?"}`),
		sinceLastAction: state.delta,   // what the last action changed: buttons and text that appeared or vanished, stats, health, console lines
		task: state.brief || undefined,
		lastConsoleLines: (state.console ?? []).slice(-5).map((l) => String(l).slice(0, 200)),
		stepsWithoutChange: Math.min(state.still ?? 0, 5),   // the raw count, 5 meaning five or more; "stuck" is Jev's call, not ours to hand it
	};
}

const questions = (opts, agent, brief) => ({
	next: {
		type: "choice",
		instructions: `You are play-testing a Roblox game as the ${agent.name}: ${agent.goal}${brief ? ` Your task from the developer: ${brief}. Work toward it step by step, then keep testing.` : ""} Pick the next action. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.`,
		criteria: Object.fromEntries(Object.entries(opts).map(([id, o]) => [id, o.text])),
	},
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: {
		true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.",
		false: "The player moves, the screen or the console changes, or new content is still being reached." } },
	noEffect: { type: "noul", instructions: "The last action did not have its intended effect.", criteria: {
		true: "The last action's outcome says failed, timeout or gave up, or sinceLastAction shows nothing at all after a click or a prompt.",
		false: "The last action arrived, clicked or walked as intended and sinceLastAction shows something, or there is no last action yet." } },
	looksWrong: { type: "noul", instructions: "Something is broken for a player, beyond the player merely not moving.", criteria: {
		true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason; the player fell through the floor, or the humanoid state is Dead or Ragdoll without a cause.",
		false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal; only the console or the states above count as broken." } },
	done: { type: "noul", instructions: "This test session is complete; nothing useful is left to try.", criteria: {
		true: brief ? `The task "${brief}" has been completed and, after it, ${agent.doneWhen}` : agent.doneWhen,
		false: "untried buttons or interactables are above 0, or stepsSinceAnythingNew is small because a new button, interactable or console line just appeared." } },
	...Object.fromEntries(Object.entries(agent.notes).map(([id, n]) => [id, { type: "noul", instructions: n.instructions, criteria: n.criteria }])),
});

async function ask(key, body) {
	for (let attempt = 0; ; attempt++) {
		const r = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
		if ((r.status === 429 || r.status === 529) && attempt < 2) { await sleep(1000 * 2 ** attempt); continue; }
		if (r.status === 401) throw Object.assign(new Error("HTTP 401: the TypeSafe key was refused"), { fatal: true });
		if (r.status === 422) throw Object.assign(new Error(`HTTP 422: ${(await r.text().catch(() => "")).slice(0, 200)}`), { fatal: true });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return r.json();
	}
}

// The agent's notes this step: a confident answer, subject to its rule (after a certain kind of action; only
// once a streak of that many steps agrees, counting the flags recorded on earlier actions).
function notesFor(agent, flags, state, history) {
	const last = history.at(-1)?.action, out = [];
	for (const [id, n] of Object.entries(agent.notes)) {
		if ((flags[id] ?? 0) < 0.7) continue;
		if (n.after && last?.kind !== n.after) continue;
		if (n.streak) {
			let run = 1;
			for (let i = history.length - 1; i >= 0 && (history[i].action?.jev?.flags?.[id] ?? 0) >= 0.7; i--) run++;
			if (run !== n.streak) continue;
		}
		out.push({ kind: n.kind, probability: flags[id], text: n.text(last, state) });
	}
	return out;
}

let warned = false, off = false, cache = { key: "", answers: null };

export async function decide(state, history) {
	const key = apiKey();
	if (off || !key) {
		if (!warned) { warned = true; log(off ? "off for this run; scripted policy" : "no TypeSafe key (PARLAY_TYPESAFE_API_KEY, ~/.parlay/typesafe-api-key or TYPESAFE_API_KEY); scripted policy"); }
		return scripted(state, history);
	}
	const agent = AGENTS[state.agent] ?? AGENTS.explorer;
	const opts = options(state, history, agent);
	const body = { model: "jev-latest", state: compact(state, history), questions: questions(opts, agent, state.brief) };
	const cacheKey = JSON.stringify(body);
	try {
		const answers = cacheKey === cache.key ? cache.answers : (await ask(key, body)).answers;
		cache = { key: cacheKey, answers };
		const pick = opts[answers?.next?.choice];
		if (!pick) throw new Error(`answered "${answers?.next?.choice}", not one of the offered actions`);
		const flag = (q) => Math.max(0, Math.min(1, Number(answers[q]?.noul ?? 0)));
		const flags = Object.fromEntries(Object.keys(body.questions).filter((q) => q !== "next").map((q) => [q, flag(q)]));
		return { ...pick.action, jev: { probabilities: answers.next.probabilities, flags, notes: notesFor(agent, flags, state, history), confidence: answers.next.confidence } };
	} catch (e) {
		if (e.fatal) off = true;
		if (!warned) { warned = true; log(`${e.message}; scripted policy ${off ? "for the rest of the run" : "for this step"}`); }
		return scripted(state, history);
	}
}

export default decide;
