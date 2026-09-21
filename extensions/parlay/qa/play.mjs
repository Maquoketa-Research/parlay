// Parlay's QA play runner: drives Roblox Studio through Roblox's own Studio MCP server, plays a place with the
// Studio test player, pokes at it (GUI buttons, prompts, a random walk), harvests console errors and stuck
// states, and writes report.json + report.md, optionally posting the errors to Aqua's ingest.
//   node qa/play.mjs --place <id> [--universe <u>] [--minutes 5] [--steps 400] [--pace-ms 500] [--policy scripted|jev]
//                    [--out .build/qa/<timestamp>] [--aqua-url <url> --aqua-key <key>] [--stop-file <path>]
// --aqua-url/--aqua-key default to PARLAY_AQUA_URL / PARLAY_AQUA_KEY; --policy to PARLAY_QA_POLICY (jev loads
// policy-jev.mjs). --stop-file is polled each step: the QA view creates it to stop Play cleanly (SIGINT is not
// reliable on Windows). The run folder also gets stepsLog.jsonl, one line per step as it happens, for the view to tail.
// A step where Jev flagged "looks wrong" at 0.7 or more without a console error is a suspect: screenshot, listed in
// the report apart from the errors, no effect on the exit code. The agent's notes (a dead button, a lost newbie)
// and the runner's own (an "exploit": a stat that moved without cause, by the code gate in shared.mjs; a
// "task-unseen": a brief naming nothing that ever appeared on screen) are listed the same way.
// Exit 0: clean. 2: findings (errors or stuck events). 1: runner failure (no Studio, seat taken, timeout).
// PARLAY_QA_MCP=mock plays against qa/mock-mcp.mjs; qa/qa-check.mjs does that end to end.
// Recorded for replay (docs/jev-research.md 4.1): the policy gets the unfiltered probe as state.raw and writes it to
// jev.jsonl; stepsLog.jsonl carries the facts, the agent's exhausted() verdict, the paths seen and the paths the
// per-agent filter hid; report.code carries the extension version and a hash of the runner, policy and probes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS } from "./agents.mjs";
import { connect as connectChrrxs } from "./chrrxs.mjs";
import { connect, SeatTaken } from "./mcp.mjs";
import { exploitGate, filterButtons, fingerprint } from "./shared.mjs";
export { fingerprint };   // moved to shared.mjs (the policy and the bench use it too); qa-check imports it from here

// ---- console classification ---------------------------------------------------------------------------------
const ERROR_WORDS = /attempt|expected|invalid|nil|not a valid member|failed|error/i;
const FRAME = /^\s*Script '.*', Line \d+/;
// error: a Luau "path:line:" message carrying an error word, or a stack frame line; warning: warn() vocabulary
export function classify(line) {
	if ((/:\d+:/.test(line) && ERROR_WORDS.test(line)) || FRAME.test(line)) return "error";
	if (/\bwarn(ing)?\b|deprecated|infinite yield/i.test(line)) return "warning";
	return "info";
}
export const isFrame = (line) => FRAME.test(line);
// which side threw, from the script path in the message (Aqua's e.s field)
export const sideOf = (msg) => /StarterPlayer|StarterGui|PlayerGui|PlayerScripts|ReplicatedFirst|CoreGui/.test(msg) ? "client" : "server";

// ---- pieces -------------------------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, f), "utf8");
// what produced a run, for attribution across runs: the installed extension has no .git, so the package version
// plus a hash over everything that shapes a step (runner, policy, agents, helpers, both probes)
const PROMPT_FILES = ["play.mjs", "policy-jev.mjs", "agents.mjs", "shared.mjs", "probe.client.luau", "probe.server.luau"];
function codeStamp() {
	let version; try { version = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version; } catch { /* no package.json beside qa/: version stays undefined */ }
	const h = createHash("sha256"); for (const f of PROMPT_FILES) { try { h.update(src(f)); } catch { /* a missing file hashes as nothing */ } }
	return { version, promptHash: h.digest("hex") };
}
// a brief's words (3 letters or more, minus these) must show up somewhere on screen for Jev to match them (3.6)
const STOPWORDS = new Set(["the", "and", "for", "with", "then", "into", "from", "that", "this", "your", "you", "are", "was", "has", "have", "not", "but", "out", "some", "any", "all", "one", "there"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);
// walk the test player to a point; waits for MoveToFinished (Humanoid gives up after 8 s on its own)
const MOVE_TO = `local player = game:GetService("Players").LocalPlayer
local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
if not hum then return "no humanoid" end
hum:MoveTo(Vector3.new($POS))
local arrived = nil
hum.MoveToFinished:Once(function(ok) arrived = ok end)
local waited = 0
while arrived == nil and waited < 9 do waited += task.wait(0.25) end
return if arrived then "arrived" elseif arrived == false then "gave up" else "timeout"`;
// where a world point is drawn right now, for a ClickDetector click (viewport pixels; on=false when off screen or behind)
const SCREEN_OF = `local cam = workspace.CurrentCamera
if not cam then return "{}" end
local v, on = cam:WorldToViewportPoint(Vector3.new($POS))
return game:GetService("HttpService"):JSONEncode({ x = math.floor(v.X), y = math.floor(v.Y), on = on and v.Z > 0 })`;

// execute_luau hands back the returned value as text; take the JSON in it even if the server decorates it
function parseJson(text) {
	try { return JSON.parse(text); } catch { /* fall through */ }
	const m = /\{[\s\S]*\}/.exec(text);
	try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

// the Studio window with our place open (its name carries "(placeId: N)"); without --place, any Studio with a place
async function findStudio(mcp, place) {
	const text = (await mcp.call("list_roblox_studios")).text;
	let list; try { list = JSON.parse(text).studios ?? []; } catch { throw new Error(`list_roblox_studios: ${text.slice(0, 200)}`); }
	const studios = list.map((s) => ({ id: String(s.id), name: s.name ?? "", placeId: /\(placeId:\s*(\d+)\)/.exec(s.name ?? "")?.[1] ?? "" }));
	return studios.find((s) => place ? s.placeId === place : s.placeId) ?? null;
}

// Roblox's public lookup, so --universe is optional when the place has to be opened
async function universeOf(place) {
	const r = await fetch(`https://apis.roblox.com/universes/v1/places/${place}/universe`, { signal: AbortSignal.timeout(10000) });
	const u = (await r.json().catch(() => ({}))).universeId;
	if (!u) throw new Error(`no universe found for place ${place} (HTTP ${r.status}); pass --universe`);
	return u;
}

// Studio's own link, started from the home folder so the window does not inherit the runner's checkout as cwd
function openStudio(url) {
	spawn("cmd.exe", ["/d", "/c", "start", "", url], { cwd: os.homedir(), detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// carry out one policy action through the MCP input tools; returns a one-line result
async function act(call, action, viewport = [1280, 720], pixels = false) {
	const client = { datamodel_type: "Client" };
	if (action.kind === "click") {
		const r = await call("user_mouse_input", { ...client, actions: [{ action: "mouseButtonClick", instance_path: action.path, ...(pixels ? { x: action.x, y: action.y } : {}) }] });
		return r.text.trim() || "clicked";
	}
	if (action.kind === "interact") {
		const moved = (await call("execute_luau", { ...client, code: MOVE_TO.replace("$POS", action.position.join(", ")) })).text.trim();
		// a ClickDetector wants the pixel where the part is drawn now, not the viewport centre; and the first virtual
		// contact at a new position only moves the cursor (measured 0/4 fires), so prime once, then click the asked times
		let at = null;
		if (action.class === "ClickDetector") {
			const s = parseJson((await call("execute_luau", { ...client, code: SCREEN_OF.replace("$POS", action.position.join(", ")) })).text);
			at = s.on ? { x: s.x, y: s.y } : { x: Math.round(viewport[0] / 2), y: Math.round(viewport[1] / 2) };
			await call("user_mouse_input", { ...client, actions: [{ action: "mouseButtonClick", ...at }] });
		}
		for (let i = 0; i < (action.times ?? 1); i++) {
			if (action.class === "ProximityPrompt") await call("user_keyboard_input", { ...client, actions: [{ action: "keyDown", key_code: "E" }, { action: "wait", wait_time_ms: 600 }, { action: "keyUp", key_code: "E" }] });
			else if (action.class === "ClickDetector") await call("user_mouse_input", { ...client, actions: [{ action: "mouseButtonClick", ...at }] });
		}
		return moved;   // a TouchTransmitter fires on arrival
	}
	const jump = action.jump ? [{ action: "keyPress", key_code: "Space" }] : [];
	await call("user_keyboard_input", { ...client, actions: [{ action: "keyDown", key_code: action.key }, { action: "wait", wait_time_ms: action.ms }, { action: "keyUp", key_code: action.key }, ...jump] });
	return `walked ${action.key} ${action.ms} ms`;
}

// screen_capture: an image block becomes a file, anything else is kept as text
async function screenshot(call, out, name) {
	try {
		const r = await call("screen_capture", { capture_id: name }, 60000);
		const img = r.content.find((c) => c.type === "image" && c.data);
		const file = img ? `${name}.${(img.mimeType ?? "image/png").split("/")[1]}` : `${name}.txt`;
		fs.writeFileSync(path.join(out, file), img ? Buffer.from(img.data, "base64") : r.text);
		return file;
	} catch (e) { return `failed: ${e.message}`; }
}

const describe = (a) => a.kind === "click" ? `click ${a.text ?? ""} (${a.path})` : a.kind === "interact" ? `${a.class} ${a.path} at ${a.distance?.toFixed?.(1)} studs` : `walk ${a.key}${a.jump ? " + jump" : ""}`;
// the exploit gate's finding as one line for the report (shared.mjs exploitGate: rule a negative, b over its own history, c drift after a walk)
const exploitText = (f, last) => f.rule === "a" ? `${f.stat} went negative (${f.before} → ${f.after}) after ${last ? describe(last) : "nothing"}`
	: f.rule === "b" ? `${f.stat} ${f.before} → ${f.after}: ${+f.perUse.toFixed(2)} per use of ${f.target.split(".").pop()}, earlier uses gave ${+f.prior.toFixed(2)}`
	: `${f.stat} ${f.before} → ${f.after} after a walk, with nothing to cause it`;

// Aqua's ingest, the way ingame/AquaChatRelay.server.luau posts a batch: POST /api/ingest/roblox with X-Aqua-Key,
// one line per error group with e = { s: side, t: trace }. Always written to aqua-ingest.json; sent when url+key are set.
async function aqua(report, out, url, key) {
	const body = {
		v: "0.5.0", placeId: Number(report.place) || report.place, placeVersion: report.placeVersion, jobId: `parlay-qa-${report.start}`,
		base: Math.floor(Date.parse(report.start) / 1000), channel: "RBXGeneral",
		messages: report.errors.map((e, i) => ({ id: i + 1, p: report.player?.name ?? "ParlayQA", u: report.player?.userId ?? 0, t: e.message.slice(0, 500), c: "ParlayQA", d: 0, e: { s: e.side, t: e.trace.join("\n").slice(0, 800) } })),
	};
	fs.writeFileSync(path.join(out, "aqua-ingest.json"), JSON.stringify(body, null, "\t"));
	if (!body.messages.length) return "nothing to send";
	if (!url || !key) return "written to aqua-ingest.json, not sent (no --aqua-url/--aqua-key)";
	try {
		const r = await fetch(`${url.replace(/\/$/, "")}/api/ingest/roblox`, { method: "POST", headers: { "Content-Type": "application/json", "X-Aqua-Key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
		return `POST ${r.status}${r.status === 401 ? " (the key does not match a game on that server)" : ""}`;
	} catch (e) { return `failed: ${e.message}`; }
}

function markdown(r) {
	const act = (h) => `step ${h.step}: ${describe(h.action)}${h.result ? ` → ${h.result}` : ""}`;
	const name = r.studio?.name.replace(/\s*\(placeId:.*\)$/, "");
	const lines = [`# QA play: place ${r.place}${name ? ` (${name})` : ""}`, "",
		`${r.start} → ${r.end ?? "?"}; ${r.steps} steps; ${r.actions.length} actions; ${r.console.lines} new console lines (${r.console.warnings} warnings); exit ${r.exitCode}`
		+ (r.placeVersion ? `; place version ${r.placeVersion}` : "") + (r.agent ? `; agent ${r.agent}` : "") + (r.doneBy ? `; ended by ${r.doneBy}` : "") + (r.brief ? `; task: ${r.brief}` : ""),
		r.failure ? `\n**Runner failure:** ${r.failure}` : null,
		"", `## Errors (${r.errors.length})`];
	for (const e of r.errors) {
		lines.push("", `### ${e.count}× ${e.message}`, `${e.side}; steps ${e.firstStep}–${e.lastStep}${e.screenshot ? `; screenshot ${e.screenshot}` : ""}`);
		if (e.trace.length) lines.push("", "```", ...e.trace, "```");
		lines.push("", "Before first sight:", ...e.actionsBefore.map((h) => `- ${act(h)}`));
	}
	lines.push("", `## Stuck (${r.stuck.length})`);
	for (const s of r.stuck) lines.push("", `### step ${s.step}: ${s.state ?? "?"} at ${JSON.stringify(s.position)}`, ...s.actions.map((h) => `- ${act(h)}`));
	if (r.policy === "jev") {
		lines.push("", `## Suspects (${(r.suspects ?? []).length})`, "", "Steps where Jev put \"something looks wrong for a player\" at 0.7 or more without a console error. Not counted in the exit code.");
		for (const s of r.suspects ?? []) {
			lines.push("", `### step ${s.step}: ${Math.round(s.probability * 100)}% looks wrong${s.screenshot ? `; screenshot ${s.screenshot}` : ""}`);
			if (s.console?.length) lines.push("", "```", ...s.console, "```");
			lines.push("", "Before:", ...s.actionsBefore.map((h) => `- ${act(h)}`));
		}
	}
	if (r.notes?.length) {
		lines.push("", `## Notes (${r.notes.length})`, "", `What the ${r.agent} agent flagged (Jev at 0.7 or more). Not counted in the exit code.`);
		for (const n of r.notes) {
			lines.push("", `### step ${n.step}: ${n.kind}: ${n.text} (${Math.round(n.probability * 100)}%)${n.screenshot ? `; screenshot ${n.screenshot}` : ""}`);
			if (n.console?.length) lines.push("", "```", ...n.console, "```");
			lines.push("", "Before:", ...n.actionsBefore.map((h) => `- ${act(h)}`));
		}
	}
	const seen = Object.entries(r.gui.seen);
	lines.push("", `## GUI: ${seen.length} buttons seen, ${r.gui.clicked.length} clicked`, ...seen.map(([p, t]) => `- ${r.gui.clicked.includes(p) ? "[x]" : "[ ]"} ${t} (${p})`));
	if (r.gui.hidden?.length || r.gui.unreachable?.length) lines.push("", `${r.gui.hidden?.length ?? 0} hidden by the ${r.agent} filter (disabled or off-window), ${r.gui.unreachable?.length ?? 0} unreachable after two failed reopens.`);
	lines.push("", `## Aqua: ${r.aqua ?? "not attempted"}`, "");
	return lines.filter((l) => l !== null).join("\n");
}

// ---- the run ------------------------------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
	const { values: a } = parseArgs({ args: argv, options: {
		place: { type: "string", default: "" }, universe: { type: "string", default: "" }, minutes: { type: "string", default: "" }, agent: { type: "string", default: process.env.PARLAY_QA_AGENT || "explorer" }, brief: { type: "string", default: "" },
		steps: { type: "string", default: "400" }, "pace-ms": { type: "string", default: "500" }, out: { type: "string" },
		"aqua-url": { type: "string", default: process.env.PARLAY_AQUA_URL ?? "" }, "aqua-key": { type: "string", default: process.env.PARLAY_AQUA_KEY ?? "" },
		policy: { type: "string", default: process.env.PARLAY_QA_POLICY === "jev" ? "jev" : "scripted" }, "stop-file": { type: "string", default: "" },
	} });
	// with Jev the agent says when it is done and the minutes are only a safety cap (20 by default); scripted plays 5
	const minutes = a.minutes ? parseFloat(a.minutes) : a.policy === "jev" ? 20 : 5, maxSteps = parseInt(a.steps, 10), pace = parseInt(a["pace-ms"], 10);
	const out = path.resolve(a.out ?? path.join(".build", "qa", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
	fs.mkdirSync(out, { recursive: true });
	process.env.PARLAY_QA_JEV_LOG = path.join(out, "jev.jsonl");   // every Jev request and answer, for offline replay and before/after comparisons
	const { decide } = await import(a.policy === "jev" ? "./policy-jev.mjs" : "./policy.mjs");
	const PROBE_SERVER = src("probe.server.luau"), PROBE_CLIENT = src("probe.client.luau");
	const report = { place: a.place, universe: a.universe || undefined, studio: null, placeVersion: undefined, policy: a.policy, agent: a.policy === "jev" ? a.agent : "explorer", brief: a.brief || undefined, doneBy: undefined, start: new Date().toISOString(), end: undefined, steps: 0, code: codeStamp(),
		actions: [], errors: [], stuck: [], suspects: [], notes: [], gui: { seen: {}, clicked: [], hidden: [], unreachable: [] }, console: { lines: 0, warnings: 0 }, aqua: undefined, failure: undefined, exitCode: 1 };
	const onScreen = new Set();   // every button text, parent name and label the run ever showed (unfiltered), for the brief check at the end
	let aborted = false;
	process.on("SIGINT", () => { if (aborted) process.exit(1); aborted = true; log("Ctrl+C: stopping Play after this step (again to quit now)"); });
	// the QA view's Stop: it creates this file, and the runner leaves the loop at the next step
	const stopAsked = () => aborted || (a["stop-file"] && fs.existsSync(a["stop-file"]) && (log("stop file seen: stopping Play"), aborted = true));
	const stepsLog = (line) => fs.appendFileSync(path.join(out, "stepsLog.jsonl"), JSON.stringify(line) + "\n");

	let mcp, playing = false;
	const call = (name, args, ms) => mcp.call(name, { studio_id: report.studio.id, ...args }, ms);
	try {
		// The built-in Studio MCP first (PARLAY_QA_MCP=mock in the checks). Its seat is one client per machine, so when
		// another client holds it the run goes through the Chrrxs bridge instead (chrrxs.mjs). PARLAY_QA_MCP=chrrxs
		// skips straight to the bridge; =builtin never falls back.
		const want = process.env.PARLAY_QA_MCP ?? "auto";
		mcp = want === "chrrxs" ? await connectChrrxs() : await connect();
		try { report.studio = await findStudio(mcp, a.place); }
		catch (e) {
			if (!(e instanceof SeatTaken) || want === "builtin") throw e;
			log("the built-in Studio MCP seat is held by another client on this machine; switching to the Chrrxs bridge");
			mcp.close();
			try { mcp = await connectChrrxs(); } catch (e2) { throw new SeatTaken(`${e.message}; Chrrxs fallback failed: ${e2.message}`); }
			report.studio = await findStudio(mcp, a.place);
		}
		report.transport = mcp.kind ?? "builtin";
		log(`studio access: ${report.transport}`);
		if (!report.studio) {
			if (!a.place) throw new Error("no Studio with a place is open; pass --place <id>");
			const universe = a.universe || await universeOf(a.place);
			log(`opening place ${a.place} (universe ${universe}) in Studio`);
			openStudio(`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${a.place}+universeId:${universe}`);
			for (const t0 = Date.now(); !report.studio && Date.now() - t0 < 90000;) {
				await sleep(5000);
				if (mcp.kind !== "chrrxs") { mcp.close(); mcp = await connect(); }   // a fresh built-in session each poll (it lists Studios at startup); the bridge is live
				report.studio = await findStudio(mcp, a.place);
			}
			if (!report.studio) throw new Error(`Studio did not list place ${a.place} within 90 s`);
		}
		report.place = report.studio.placeId || a.place;
		log(`studio ${report.studio.id}: ${report.studio.name}`);
		log((await call("get_studio_state")).text.trim().replace(/\n/g, " | "));
		await call("start_stop_play", { is_start: true });
		playing = true;
		for (const t0 = Date.now(); ; await sleep(2000)) {
			const state = (await call("get_studio_state")).text;
			if (/\bClient\b/.test(state) && /\bServer\b/.test(state)) break;
			if (Date.now() - t0 > 60000) throw new Error(`Play did not start within 60 s: ${state.trim().replace(/\n/g, " | ")}`);
		}
		let lastConsole = (await call("get_console_output")).text;   // the whole log so far; new lines are whatever grows past it
		let lastError = null, lastPos = "", lastGui = "", streak = 0, recent = [], warnedProbe = 0, doneStreak = 0;
		// for the agents' "nothing left": every button and interactable ever seen, every console fingerprint ever seen (the
		// startup log counts), and steps since one was new; a repeat of a known line is not new, so a chatty game still exhausts
		const seenPaths = new Set(), seenButtons = new Set(), seenFingerprints = new Set(); let sinceNew = 0, lastNewLines = 0, lastNewFingerprints = 0;
		for (const l of lastConsole.split(/\r?\n/)) if (l.trim()) seenFingerprints.add(fingerprint(l));
		let prev = null, lastRaw = null;   // last step's snapshot (for the delta the policy judges the last action by) and its unfiltered client probe (for lastClicked)
		// reopen bookkeeping (3.2): the click that first revealed each path (null after a walk: a one-shot popup never holds a
		// run open), failed reopens per opener, targets given up after two, and the reopen whose outcome the next probe settles
		const opener = {}, reopenTries = new Map(), unreachable = new Set(), hiddenPaths = new Set(); let pendingReopen = null;
		// exploit gate memory (3.4): per stat, what each target gave per use so far and |gain| over the two latest walk steps;
		// uses per target for the breaker's least-used cap; one exploit note per (stat, target) a run
		const perUse = {}, walkGains = {}, usesOf = {}, exploited = new Set();
		const deadline = Date.now() + minutes * 60000, history = report.actions;
		for (let step = 1; step <= maxSteps && Date.now() < deadline && !stopAsked(); step++) {
			report.steps = step;
			const server = parseJson((await call("execute_luau", { datamodel_type: "Server", code: PROBE_SERVER })).text);
			const rawClient = parseJson((await call("execute_luau", { datamodel_type: "Client", code: PROBE_CLIENT })).text);
			// the one per-agent filter (3.3): everything from here down, the policy included, sees the kept list, so the facts,
			// the delta, the stuck signature and the offer agree; the raw probe rides along as state.raw for the record
			const { kept, dropped } = filterButtons(rawClient.buttons, AGENTS[a.agent]?.offers);
			const client = { ...rawClient, buttons: kept };
			for (const b of dropped) hiddenPaths.add(b.path);
			report.gui.hidden = [...hiddenPaths];
			for (const b of rawClient.buttons ?? []) { onScreen.add(b.text); onScreen.add(b.parent); }
			for (const t of rawClient.text ?? []) onScreen.add(t);
			report.placeVersion ??= server.placeVersion;
			report.player ??= server.player && { name: server.player.name, userId: server.player.userId };
			for (const b of client.buttons) { report.gui.seen[b.path] ??= b.text; seenButtons.add(b.path); }
			if (!server.player && !warnedProbe++) log(`the server probe returned no player (${JSON.stringify(server).slice(0, 160)}); movement and stuck detection are off until it does`);
			const paths = [...client.buttons.map((b) => b.path), ...(server.interactables ?? []).slice(0, 10).map((t) => t.path)];
			const unseen = paths.filter((p) => !seenPaths.has(p)); unseen.forEach((p) => seenPaths.add(p));
			sinceNew = unseen.length || lastNewFingerprints ? 0 : sinceNew + 1;
			const triedPaths = new Set(history.map((h) => h.action?.path).filter(Boolean));
			// what first appeared now is credited to the click just before it; a reopen that brought none of its targets back is a failure
			const visible = new Set(paths), last = history.at(-1)?.action, lastClick = last?.kind === "click" ? last.path : null;
			for (const p of unseen) opener[p] = lastClick;
			if (pendingReopen && !pendingReopen.targets.some((p) => visible.has(p))) {
				const n = (reopenTries.get(pendingReopen.opener) ?? 0) + 1; reopenTries.set(pendingReopen.opener, n);
				if (n >= 2) pendingReopen.targets.forEach((p) => unreachable.add(p));
			}
			report.gui.unreachable = [...unreachable];
			// hidden is about buttons only: a prompt that drifts out of the nearest ten is not a closed menu, and a reopen click cannot bring it back
			const hidden = [...seenButtons].filter((p) => !visible.has(p) && !triedPaths.has(p) && !unreachable.has(p));
			const reachable = hidden.filter((p) => opener[p] && visible.has(opener[p]) && (reopenTries.get(opener[p]) ?? 0) < 2);
			const hiddenByOpener = {}; for (const p of reachable) (hiddenByOpener[opener[p]] ??= []).push(p);
			const facts = { untriedButtons: client.buttons.filter((b) => !triedPaths.has(b.path)).length, untriedInteractables: (server.interactables ?? []).slice(0, 10).filter((t) => !triedPaths.has(t.path)).length, sinceNew, hiddenReachable: reachable.length };
			const snap = { buttons: client.buttons.map((b) => b.text || b.path.split(".").pop()), text: client.text ?? [], stats: JSON.stringify(server.leaderstats ?? null), statsObj: server.leaderstats ?? {}, health: server.player?.health };
			const diff = (now, was) => now.filter((x) => !was.includes(x)).slice(0, 8);
			const delta = prev ? { buttonsAdded: diff(snap.buttons, prev.buttons), buttonsRemoved: diff(prev.buttons, snap.buttons), textAdded: diff(snap.text, prev.text), textRemoved: diff(prev.text, snap.text), statsChanged: snap.stats !== prev.stats, healthChanged: snap.health !== prev.health, consoleLines: lastNewLines } : undefined;
			// every numeric stat (leaderstats plus Health) before and after the last action, then the code gate on the changed ones
			// against what this run saw earlier; only after that does this step's gain join the memory
			const times = last?.times ?? 1, num = (x) => typeof x === "number";
			const moves = prev ? [...Object.entries(snap.statsObj).map(([name, after]) => ({ name, before: prev.statsObj[name], after })), { name: "Health", before: prev.health, after: snap.health }].filter((s) => num(s.before) && num(s.after)) : [];
			const statsDelta = moves.filter((s) => s.name !== "Health" && s.before !== s.after).map((s) => ({ ...s, gain: s.after - s.before, perUse: (s.after - s.before) / times }));
			const health = moves.find((s) => s.name === "Health" && s.before !== s.after);
			// a death or a respawn (Health to or from 0) is looksWrong's territory, not a stat that moved without cause: it never reaches
			// the gate or its memory; an interact that never reached its prompt ("gave up", "timeout") leaves no per-use baseline either
			const gated = moves.filter((s) => !(s.name === "Health" && (s.before === 0 || s.after === 0)));
			const arrived = last?.kind !== "interact" || /^arrived/.test(String(history.at(-1)?.result ?? ""));
			const exploitNotes = [];
			for (const s of gated.filter((s) => s.before !== s.after)) for (const f of exploitGate({ stats: [s], lastAction: last, usesBefore: perUse[s.name] ?? {}, walkGains: walkGains[s.name] ?? [] })) {
				const key = `${f.stat}|${f.target ?? "walk"}`;
				if (!exploited.has(key)) { exploited.add(key); exploitNotes.push({ kind: "exploit", probability: 1, text: exploitText(f, last) }); }
			}
			for (const s of gated) {
				if (last?.kind === "walk") walkGains[s.name] = [...(walkGains[s.name] ?? []), Math.abs(s.after - s.before)].slice(-2);
				else if (last?.path && arrived) ((perUse[s.name] ??= {})[last.path] ??= []).push((s.after - s.before) / times);
			}
			prev = snap;
			// the button clicked last step as the probe saw it before that click (unfiltered, so the breaker's disabled buttons show interactable: false)
			const lastBtn = last?.kind === "click" ? (lastRaw?.buttons ?? []).find((b) => b.path === last.path) : undefined;
			const lastClicked = last?.kind === "click" ? { text: lastBtn?.text ?? last.text, parent: lastBtn?.parent, interactable: lastBtn?.interactable } : undefined;
			// raw is the whole decide() input before the per-agent filter, the run-scoped facts included (lastClicked, hidden, statsDelta,
			// health, usesOf cannot be rebuilt from one probe); the policy writes it to jev.jsonl verbatim, so raw plus report.actions replays a step
			const raw = { server, client: rawClient, delta, console: recent, still: streak, sinceNew, stuck: streak >= 5, agent: a.agent, brief: a.brief,
				lastClicked, hidden: hiddenByOpener, statsDelta, health: health && { before: health.before, after: health.after }, usesOf: { ...usesOf } };
			const action = await decide({ ...raw, client, raw }, history);
			pendingReopen = action.reopen ? { opener: action.path, targets: reachable.filter((p) => opener[p] === action.path) } : null;
			// notes judge the action before this one, so their evidence is the screen and console as they are now, before acting;
			// a reopen click is a tester's own move, never a dead button
			const notes = [...exploitNotes, ...(action.jev?.notes ?? []).filter((n) => !(last?.reopen && n.kind === "dead-button"))];
			let file = notes.length ? await screenshot(call, out, `note-${notes[0].kind}-step-${step}`) : undefined;
			for (const n of notes) report.notes.push({ step, kind: n.kind, text: n.text, probability: n.probability, screenshot: file, console: recent, actionsBefore: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			const entry = { step, t: new Date().toISOString(), action, position: server.player?.position, health: server.player?.health, leaderstats: server.leaderstats };
			entry.result = await act(call, action, client.viewport, mcp.pixels).catch((e) => `failed: ${e.message}`);
			if (action.kind === "click" && !report.gui.clicked.includes(action.path)) report.gui.clicked.push(action.path);
			if (action.path) usesOf[action.path] = (usesOf[action.path] ?? 0) + (action.times ?? 1);
			history.push(entry);
			lastRaw = rawClient;
			// console diff; a cleared log starts over
			const now = (await call("get_console_output")).text;
			const fresh = now.startsWith(lastConsole) ? now.slice(lastConsole.length) : now;
			lastConsole = now;
			const newLines = fresh.split(/\r?\n/).filter((l) => l.trim());
			lastNewLines = newLines.length;
			let newFingerprints = 0;
			for (const l of newLines) { const fp = fingerprint(l); if (!seenFingerprints.has(fp)) { seenFingerprints.add(fp); newFingerprints++; } }
			lastNewFingerprints = newFingerprints;
			recent = newLines.slice(-5);
			let newGroups = 0, errorLines = 0;
			for (const line of newLines) {
				const kind = classify(line);
				if (kind === "warning") report.console.warnings++;
				if (kind !== "error") continue;
				errorLines++;
				if (isFrame(line) && lastError) { if (!lastError.trace.includes(line.trim())) lastError.trace.push(line.trim()); continue; }
				const fp = fingerprint(line);
				let err = report.errors.find((e) => e.fingerprint === fp);
				if (!err) {
					err = { fingerprint: fp, message: line.trim(), side: sideOf(line), count: 0, firstStep: step, lastStep: step, trace: [], screenshot: undefined,
						actionsBefore: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) };
					report.errors.push(err); newGroups++;
				}
				err.count++; err.lastStep = step; lastError = err;
			}
			report.console.lines += newLines.length;
			// stuck: nothing moved, nothing new logged (a repeat of a known line does not count), nothing on screen changed, five
			// steps running; one event per streak
			const pos = server.player?.position ? JSON.stringify(server.player.position.map(Math.round)) : null;
			const gui = client.buttons.map((b) => b.path).sort().join("|");
			// only steps that tried to move count: a UI tester clicking in place is not stuck, so click steps leave the streak alone
			streak = action.kind === "click" ? streak : pos !== null && pos === lastPos && gui === lastGui && newFingerprints === 0 ? streak + 1 : 0;
			lastPos = pos; lastGui = gui;
			if (streak === 5) report.stuck.push({ step, position: server.player?.position, state: server.player?.state, actions: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			// suspect: Jev confident that something looks wrong, with no console error to pin it on (the 0.7 is code, not Jev's)
			const wrong = action.jev?.flags?.looksWrong ?? 0, suspect = wrong >= 0.7 && !errorLines && streak < 5;
			// "nothing left to try": the agent's rule on the facts (logged for every policy), which with Jev overrides its hedging on an empty place
			const exhaustedFacts = !!AGENTS[a.agent]?.exhausted?.(facts), exhausted = !!action.jev && exhaustedFacts, done = exhausted ? 1 : action.jev?.flags?.done ?? 0;
			// the post-action screenshot: errors and suspects always, the every-tenth-step one only when a note did not already capture this step
			if (newGroups || suspect || (step % 10 === 0 && !file)) file = await screenshot(call, out, newGroups ? `error-${report.errors.length}-step-${step}` : suspect ? `suspect-step-${step}` : `step-${step}`);
			if (newGroups) for (const e of report.errors.slice(-newGroups)) e.screenshot = file;
			if (suspect) report.suspects.push({ step, probability: wrong, screenshot: file, console: recent, actionsBefore: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			stepsLog({ step, action, outcome: entry.result, newLines, errorGroups: report.errors.length, stuck: streak >= 5, suspect, done, notes: notes.map((n) => n.kind), screenshot: file,
				facts, exhausted: exhaustedFacts, seen: paths, hidden: dropped.map((b) => b.path) });
			log(`step ${step}: ${describe(action)} → ${entry.result}; +${newLines.length} lines; ${report.errors.length} error groups${streak >= 5 ? "; stuck" : ""}${action.jev ? `; jev wrong ${wrong.toFixed(2)}` : ""}${suspect ? "; suspect" : ""}${notes.length ? `; note: ${notes.map((n) => n.kind).join(", ")}` : ""}${action.jev ? `; done ${done.toFixed(2)}` : ""}`);
			// the agent ends the session: three steps in a row at 0.8 or more, after a minimum of eight steps
			doneStreak = done >= 0.8 ? doneStreak + 1 : 0;
			if (doneStreak >= 3 && step >= 8) { report.doneBy = exhausted ? "exhausted" : "jev"; log(exhausted ? `nothing left for the ${report.agent} agent to try (${facts.untriedButtons} untried buttons, ${facts.untriedInteractables} untried interactables, ${sinceNew} steps since anything new); stopping Play` : `the ${report.agent} agent says this session is done (${done.toFixed(2)} three steps running); stopping Play`); break; }
			if (pace) await sleep(pace);
		}
		report.doneBy ??= aborted ? "stopped" : "cap";
		report.exitCode = report.errors.length || report.stuck.length ? 2 : 0;
	} catch (e) {
		report.failure = e instanceof SeatTaken ? `Studio MCP seat taken: ${e.message}` : e.message;
		report.exitCode = 1;
		log(`runner failure: ${report.failure}`);
	} finally {
		if (playing) await call("start_stop_play", { is_start: false }).then(() => log("Play stopped"), (e) => log(`stop failed: ${e.message}`));
		mcp?.close();
	}
	// a brief Jev could never match (3.6): none of its words showed up in any button text, parent or label all run, so the
	// developer should reword it to what is on screen rather than read the run as Jev ignoring the task
	if (a.brief) {
		const blob = [...onScreen].filter(Boolean).join("\n").toLowerCase();
		const words = (a.brief.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
		if (words.length && !words.some((w) => blob.includes(w))) report.notes.push({ step: report.steps, kind: "task-unseen", text: `task names nothing seen on screen: ${words.join(", ")}`, probability: 1, screenshot: undefined, console: [], actionsBefore: [] });
	}
	report.end = new Date().toISOString();
	report.aqua = await aqua(report, out, a["aqua-url"], a["aqua-key"]);
	fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, "\t"));
	fs.writeFileSync(path.join(out, "report.md"), markdown(report));
	log(`report: ${out} (${report.errors.length} error groups, ${report.stuck.length} stuck, exit ${report.exitCode})`);
	return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main().then((code) => process.exit(code));
