// Parlay's QA play runner: drives Roblox Studio through Roblox's own Studio MCP server, plays a place with the
// Studio test player, pokes at it (GUI buttons, prompts, a random walk), harvests console errors and stuck
// states, and writes report.json + report.md, optionally posting the errors to Aqua's ingest.
//   node qa/play.mjs --place <id> [--universe <u>] [--minutes 5] [--steps 400] [--pace-ms 500] [--policy scripted|jev]
//                    [--out .build/qa/<timestamp>] [--aqua-url <url> --aqua-key <key>] [--stop-file <path>]
// --aqua-url/--aqua-key default to PARLAY_AQUA_URL / PARLAY_AQUA_KEY; --policy to PARLAY_QA_POLICY (jev loads
// policy-jev.mjs). --stop-file is polled each step: the QA view creates it to stop Play cleanly (SIGINT is not
// reliable on Windows). The run folder also gets stepsLog.jsonl, one line per step as it happens, for the view to tail.
// A step where Jev flagged "looks wrong" at 0.7 or more without a console error is a suspect: screenshot, listed in
// the report apart from the errors, no effect on the exit code.
// Exit 0: clean. 2: findings (errors or stuck events). 1: runner failure (no Studio, seat taken, timeout).
// PARLAY_QA_MCP=mock plays against qa/mock-mcp.mjs; qa/qa-check.mjs does that end to end.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect as connectChrrxs } from "./chrrxs.mjs";
import { connect, SeatTaken } from "./mcp.mjs";

// ---- console classification ---------------------------------------------------------------------------------
const ERROR_WORDS = /attempt|expected|invalid|nil|not a valid member|failed|error/i;
const FRAME = /^\s*Script '.*', Line \d+/;
// error: a Luau "path:line:" message carrying an error word, or a stack frame line; warning: warn() vocabulary
export function classify(line) {
	if ((/:\d+:/.test(line) && ERROR_WORDS.test(line)) || FRAME.test(line)) return "error";
	if (/\bwarn(ing)?\b|deprecated|infinite yield/i.test(line)) return "warning";
	return "info";
}
// the same error at another line, id, count or GUID folds into one group
export function fingerprint(line) {
	return line.trim().replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#").replace(/\d+/g, "#").replace(/\s+/g, " ");
}
export const isFrame = (line) => FRAME.test(line);
// which side threw, from the script path in the message (Aqua's e.s field)
export const sideOf = (msg) => /StarterPlayer|StarterGui|PlayerGui|PlayerScripts|ReplicatedFirst|CoreGui/.test(msg) ? "client" : "server";

// ---- pieces -------------------------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const luau = (f) => fs.readFileSync(path.join(here, f), "utf8");
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
		for (let i = 0; i < (action.times ?? 1); i++) {
			if (action.class === "ProximityPrompt") await call("user_keyboard_input", { ...client, actions: [{ action: "keyDown", key_code: "E" }, { action: "wait", wait_time_ms: 600 }, { action: "keyUp", key_code: "E" }] });
			else if (action.class === "ClickDetector") await call("user_mouse_input", { ...client, actions: [{ action: "mouseButtonClick", x: Math.round(viewport[0] / 2), y: Math.round(viewport[1] / 2) }] });
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
		+ (r.placeVersion ? `; place version ${r.placeVersion}` : "") + (r.agent ? `; agent ${r.agent}` : "") + (r.doneBy ? `; ended by ${r.doneBy}` : ""),
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
	lines.push("", `## Aqua: ${r.aqua ?? "not attempted"}`, "");
	return lines.filter((l) => l !== null).join("\n");
}

// ---- the run ------------------------------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
	const { values: a } = parseArgs({ args: argv, options: {
		place: { type: "string", default: "" }, universe: { type: "string", default: "" }, minutes: { type: "string", default: "" }, agent: { type: "string", default: process.env.PARLAY_QA_AGENT || "explorer" },
		steps: { type: "string", default: "400" }, "pace-ms": { type: "string", default: "500" }, out: { type: "string" },
		"aqua-url": { type: "string", default: process.env.PARLAY_AQUA_URL ?? "" }, "aqua-key": { type: "string", default: process.env.PARLAY_AQUA_KEY ?? "" },
		policy: { type: "string", default: process.env.PARLAY_QA_POLICY === "jev" ? "jev" : "scripted" }, "stop-file": { type: "string", default: "" },
	} });
	// with Jev the agent says when it is done and the minutes are only a safety cap (20 by default); scripted plays 5
	const minutes = a.minutes ? parseFloat(a.minutes) : a.policy === "jev" ? 20 : 5, maxSteps = parseInt(a.steps, 10), pace = parseInt(a["pace-ms"], 10);
	const out = path.resolve(a.out ?? path.join(".build", "qa", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
	fs.mkdirSync(out, { recursive: true });
	const { decide } = await import(a.policy === "jev" ? "./policy-jev.mjs" : "./policy.mjs");
	const PROBE_SERVER = luau("probe.server.luau"), PROBE_CLIENT = luau("probe.client.luau");
	const report = { place: a.place, universe: a.universe || undefined, studio: null, placeVersion: undefined, policy: a.policy, agent: a.policy === "jev" ? a.agent : "explorer", doneBy: undefined, start: new Date().toISOString(), end: undefined, steps: 0,
		actions: [], errors: [], stuck: [], suspects: [], notes: [], gui: { seen: {}, clicked: [] }, console: { lines: 0, warnings: 0 }, aqua: undefined, failure: undefined, exitCode: 1 };
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
		const deadline = Date.now() + minutes * 60000, history = report.actions;
		for (let step = 1; step <= maxSteps && Date.now() < deadline && !stopAsked(); step++) {
			report.steps = step;
			const server = parseJson((await call("execute_luau", { datamodel_type: "Server", code: PROBE_SERVER })).text);
			const client = parseJson((await call("execute_luau", { datamodel_type: "Client", code: PROBE_CLIENT })).text);
			report.placeVersion ??= server.placeVersion;
			report.player ??= server.player && { name: server.player.name, userId: server.player.userId };
			for (const b of client.buttons ?? []) report.gui.seen[b.path] ??= b.text;
			if (!server.player && !warnedProbe++) log(`the server probe returned no player (${JSON.stringify(server).slice(0, 160)}); movement and stuck detection are off until it does`);
			const action = await decide({ server, client, stuck: streak >= 5, still: streak, console: recent, agent: a.agent }, history);
			const entry = { step, t: new Date().toISOString(), action, position: server.player?.position, health: server.player?.health, leaderstats: server.leaderstats };
			entry.result = await act(call, action, client.viewport, mcp.pixels).catch((e) => `failed: ${e.message}`);
			if (action.kind === "click" && !report.gui.clicked.includes(action.path)) report.gui.clicked.push(action.path);
			history.push(entry);
			// console diff; a cleared log starts over
			const now = (await call("get_console_output")).text;
			const fresh = now.startsWith(lastConsole) ? now.slice(lastConsole.length) : now;
			lastConsole = now;
			const newLines = fresh.split(/\r?\n/).filter((l) => l.trim());
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
			// stuck: nothing moved, nothing logged, nothing on screen changed, five steps running; one event per streak
			const pos = server.player?.position ? JSON.stringify(server.player.position.map(Math.round)) : null;
			const gui = (client.buttons ?? []).map((b) => b.path).sort().join("|");
			streak = pos !== null && pos === lastPos && gui === lastGui && newLines.length === 0 ? streak + 1 : 0;
			lastPos = pos; lastGui = gui;
			if (streak === 5) report.stuck.push({ step, position: server.player?.position, state: server.player?.state, actions: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			// suspect: Jev confident that something looks wrong, with no console error to pin it on (the 0.7 is code, not Jev's)
			const wrong = action.jev?.flags?.looksWrong ?? 0, suspect = wrong >= 0.7 && !errorLines && streak < 5;
			const notes = action.jev?.notes ?? [], done = action.jev?.flags?.done ?? 0;   // the agent's own findings, and its "nothing left to try"
			let file;
			if (newGroups || suspect || notes.length || step % 10 === 0) file = await screenshot(call, out, newGroups ? `error-${report.errors.length}-step-${step}` : suspect ? `suspect-step-${step}` : notes.length ? `note-${notes[0].kind}-step-${step}` : `step-${step}`);
			if (newGroups) for (const e of report.errors.slice(-newGroups)) e.screenshot = file;
			if (suspect) report.suspects.push({ step, probability: wrong, screenshot: file, console: recent, actionsBefore: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			for (const n of notes) report.notes.push({ step, kind: n.kind, text: n.text, probability: n.probability, screenshot: file, console: recent, actionsBefore: history.slice(-5).map(({ step, action, result }) => ({ step, action, result })) });
			stepsLog({ step, action, outcome: entry.result, newLines, errorGroups: report.errors.length, stuck: streak >= 5, suspect, done, notes: notes.map((n) => n.kind), screenshot: file });
			log(`step ${step}: ${describe(action)} → ${entry.result}; +${newLines.length} lines; ${report.errors.length} error groups${streak >= 5 ? "; stuck" : ""}${action.jev ? `; jev wrong ${wrong.toFixed(2)}` : ""}${suspect ? "; suspect" : ""}${notes.length ? `; note: ${notes.map((n) => n.kind).join(", ")}` : ""}${action.jev ? `; done ${done.toFixed(2)}` : ""}`);
			// the agent ends the session: three steps in a row at 0.8 or more, after a minimum of eight steps
			doneStreak = done >= 0.8 ? doneStreak + 1 : 0;
			if (doneStreak >= 3 && step >= 8) { report.doneBy = "jev"; log(`the ${report.agent} agent says this session is done (${done.toFixed(2)} three steps running); stopping Play`); break; }
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
	report.end = new Date().toISOString();
	report.aqua = await aqua(report, out, a["aqua-url"], a["aqua-key"]);
	fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, "\t"));
	fs.writeFileSync(path.join(out, "report.md"), markdown(report));
	log(`report: ${out} (${report.errors.length} error groups, ${report.stuck.length} stuck, exit ${report.exitCode})`);
	return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main().then((code) => process.exit(code));
