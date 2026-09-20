// Jev (TypeSafe's model) as the play policy: the same decide(state, history) → action contract as policy.mjs.
// One POST per step: a "choice" over the concrete actions this code enumerates (visible unvisited buttons, nearby
// unvisited interactables, four walks and a longer random explore) and three yes/no "noul" flags (the player is
// stuck, the last action had no effect, something looks wrong for a player). The flags ride back on action.jev so
// the runner records them per step and turns a confident "looks wrong" into a suspect finding.
// Jev reads text only, is literal and is bad at numbers, so the arithmetic (distances, indices, the 0.7 threshold)
// and the safety rules (only an offered action, never a visited target, walks only when stuck) stay here, and the
// state it sees is small and structured. Any failure falls back to the scripted policy, logged once; 401 and 422
// turn Jev off for the rest of the run, 429 and 529 are retried twice with backoff. The key never reaches a log.
//   key:      PARLAY_TYPESAFE_API_KEY (what the QA view passes from SecretStorage), else ~/.parlay/typesafe-api-key
//             (one line), else TYPESAFE_API_KEY
//   endpoint: PARLAY_QA_JEV_URL (qa-check.mjs points it at a mock), else https://api.typesafe.ai/v1/systemone
// Response, as verified 2026-09-20 against the live API: { model: "jev-1.13.0" (a pinned version, not the alias
// sent), answers: { <id>: { type: "noul", noul } | { type: "choice", choice, confidence, probabilities } },
// usage }. Option ids round-trip verbatim; underscores (interact_0) are the verified form, so no colons here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scripted from "./policy.mjs";

const ENDPOINT = process.env.PARLAY_QA_JEV_URL || "https://api.typesafe.ai/v1/systemone";
const WALK = { W: "forward", A: "left", S: "back", D: "right" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), "jev:", ...m);
const describe = (a) => a.kind === "click" ? `click "${a.text ?? ""}"` : a.kind === "interact" ? `${a.class} ${a.path.split(".").pop()}` : `walk ${WALK[a.key] ?? a.key}${a.jump ? " + jump" : ""}`;

function apiKey() {
	if (process.env.PARLAY_TYPESAFE_API_KEY) return process.env.PARLAY_TYPESAFE_API_KEY;
	try { return fs.readFileSync(path.join(os.homedir(), ".parlay", "typesafe-api-key"), "utf8").trim() || process.env.TYPESAFE_API_KEY; } catch { return process.env.TYPESAFE_API_KEY; }
}

// The actions on offer this step: option id → { action (the runner's shape), text (the line Jev reads) }.
// Stuck means the last five tries changed nothing, so only movement is offered, as policy.mjs does.
function options(state, history) {
	const done = new Set(history.map((h) => h.action?.path).filter(Boolean));
	const out = {};
	if (!state.stuck) {
		(state.client?.buttons ?? []).forEach((b, i) => { if (!done.has(b.path)) out[`click_${i}`] = { action: { kind: "click", path: b.path, text: b.text, x: b.x, y: b.y }, text: `Click the "${b.text}" ${b.class ?? "button"} on screen` }; });
		(state.server?.interactables ?? []).slice(0, 10).forEach((t, i) => { if (!done.has(t.path)) out[`interact_${i}`] = { action: { kind: "interact", path: t.path, class: t.class, position: t.position, distance: t.distance }, text: `Walk ${Math.round(t.distance ?? 0)} studs to the ${t.class} "${t.text || t.path.split(".").pop()}" and use it` }; });
	}
	for (const [key, dir] of Object.entries(WALK)) out[`walk_${key}`] = { action: { kind: "walk", key, ms: 800, jump: true }, text: `Walk ${dir} for a second and jump` };
	out.explore = { action: { kind: "walk", key: "WASD"[Math.floor(Math.random() * 4)], ms: 1500, jump: true }, text: "Wander in a random direction for longer, jumping, to reach somewhere new" };
	return out;
}

// What Jev sees: rounded numbers, names not paths, the last five actions and console lines. No step numbers, so
// a frozen game produces the same state twice and the cached answer is reused instead of a call.
function compact(state, history) {
	const p = state.server?.player;
	return {
		player: p ? { position: (p.position ?? []).map(Math.round), health: p.health, state: p.state } : "no player yet",
		leaderstats: state.server?.leaderstats,
		buttonsOnScreen: (state.client?.buttons ?? []).map((b) => b.text),
		interactablesNearby: (state.server?.interactables ?? []).slice(0, 10).map((t) => `${t.class} ${t.path.split(".").pop()} at ${Math.round(t.distance ?? 0)} studs`),
		lastActions: history.slice(-5).map((h) => `${describe(h.action)} → ${h.result ?? "?"}`),
		lastConsoleLines: (state.console ?? []).slice(-5).map((l) => String(l).slice(0, 200)),
		stepsWithoutChange: Math.min(state.still ?? 0, 5),   // the raw count, 5 meaning five or more (frozen steps look alike, so the cache answers them); "stuck" is Jev's call, not ours to hand it
	};
}

const questions = (opts) => ({
	next: {
		type: "choice",
		instructions: "You are play-testing a Roblox game to find bugs. Pick the next action most likely to reveal a bug or reach content the player has not seen yet. Prefer what has not been tried; when the last actions changed nothing, move somewhere else.",
		criteria: Object.fromEntries(Object.entries(opts).map(([id, o]) => [id, o.text])),
	},
	stuck: { type: "noul", instructions: "The player appears stuck.", criteria: {
		true: "The last actions changed nothing: same position, same buttons on screen, no new console lines; or the humanoid state is a fall, seat or ragdoll the player cannot leave.",
		false: "The player moves, the screen or the console changes, or new content is still being reached." } },
	noEffect: { type: "noul", instructions: "The last action did not have its intended effect.", criteria: {
		true: "The last action's outcome says failed, timeout or gave up, or nothing changed after a click, a prompt or a walk.",
		false: "The last action arrived, clicked or walked as intended, or there is no last action yet." } },
	looksWrong: { type: "noul", instructions: "Something is broken for a player, beyond the player merely not moving.", criteria: {
		true: "A console line reports an error, a nil or missing object or an infinite yield; a button or prompt did nothing when used; health or stats changed for no reason; the player fell through the floor, or the humanoid state is Dead or Ragdoll without a cause.",
		false: "Walking, jumping, standing still, a plain or empty map, and steps that changed nothing are all normal; only the console or the states above count as broken." } },
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

let warned = false, off = false, cache = { key: "", answers: null };

export async function decide(state, history) {
	const key = apiKey();
	if (off || !key) {
		if (!warned) { warned = true; log(off ? "off for this run; scripted policy" : "no TypeSafe key (PARLAY_TYPESAFE_API_KEY, ~/.parlay/typesafe-api-key or TYPESAFE_API_KEY); scripted policy"); }
		return scripted(state, history);
	}
	const opts = options(state, history);
	const body = { model: "jev-latest", state: compact(state, history), questions: questions(opts) };
	const cacheKey = JSON.stringify(body);
	try {
		const answers = cacheKey === cache.key ? cache.answers : (await ask(key, body)).answers;
		cache = { key: cacheKey, answers };
		const pick = opts[answers?.next?.choice];
		if (!pick) throw new Error(`answered "${answers?.next?.choice}", not one of the offered actions`);
		const flag = (q) => Math.max(0, Math.min(1, Number(answers[q]?.noul ?? 0)));
		return { ...pick.action, jev: { probabilities: answers.next.probabilities, flags: { stuck: flag("stuck"), noEffect: flag("noEffect"), looksWrong: flag("looksWrong") }, confidence: answers.next.confidence } };
	} catch (e) {
		if (e.fatal) off = true;
		if (!warned) { warned = true; log(`${e.message}; scripted policy ${off ? "for the rest of the run" : "for this step"}`); }
		return scripted(state, history);
	}
}

export default decide;
