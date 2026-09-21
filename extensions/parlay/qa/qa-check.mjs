// The one check for the QA play runner: node --no-warnings qa/qa-check.mjs
// The console classifier and fingerprint on the fixture lines, then a whole play against the mock MCP
// (PARLAY_QA_MCP=mock): the seeded error grouped once with its trace, the stuck detector firing on the frozen
// state, exit 2; and exit 1 when the mock says the seat is taken. Then the Jev policy against a mock TypeSafe
// (PARLAY_QA_JEV_URL): its choice becomes the action with the flags on it, a confident "looks wrong" without a
// console error becomes a suspect, a 401 falls back to the scripted policy; and --stop-file ends the run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, fingerprint, isFrame, sideOf } from "./play.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// classifier: the fixture console, line by line
const lines = fs.readFileSync(path.join(here, "fixtures", "console.txt"), "utf8").trimEnd().split(/\r?\n/);
assert.deepEqual(lines.map(classify), ["info", "info", "info", "error", "info", "error", "info", "warning", "error", "info", "error", "info"]);
assert.equal(classify("Requiring asset 12345678"), "info");   // a number without an error word is not an error
assert.equal(classify("ReplicatedStorage.Util:3: X is not a valid member of Folder \"ReplicatedStorage\""), "error");
assert.equal(classify("[Aqua] warning: relay key unset"), "warning");
assert.ok(isFrame("  Script 'ServerScriptService.Shop.Buy', Line 105 - function buy") && !isFrame("Stack Begin"));
assert.equal(sideOf("Players.Dave.PlayerGui.Shop.Click:9: x"), "client");
assert.equal(sideOf("ServerScriptService.Shop.Buy:105: x"), "server");
// fingerprint: numbers, ids and spacing fold; words do not
assert.equal(fingerprint("ServerScriptService.Shop.Buy:105: attempt to index nil with 'X'"), fingerprint("ServerScriptService.Shop.Buy:107:  attempt to index nil with 'X'"));
assert.equal(fingerprint("Workspace.Part 12345:3: failed for 7f3c1a2e-0000-4000-8000-000000000001"), "Workspace.Part #:#: failed for #");
assert.notEqual(fingerprint("A:1: attempt to index nil with 'X'"), fingerprint("A:1: attempt to index nil with 'Y'"));

// a whole play against the mock; each run gets its own folder. Async (spawn, not spawnSync): the mock TypeSafe
// below lives in this process and has to answer while the runner plays.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "parlay-qa-"));
let runs = 0;
const run = (env, ...extra) => new Promise((resolve) => {
	const out = path.join(tmp, String(++runs));
	const child = spawn(process.execPath, [path.join(here, "play.mjs"), "--place", "90044978600719", "--minutes", "0.2", "--steps", "30", "--pace-ms", "0", "--out", out, ...extra],
		{ env: { ...process.env, PARLAY_QA_MCP: "mock", PARLAY_QA_POLICY: "", PARLAY_TYPESAFE_API_KEY: "", PARLAY_QA_CHRRXS_URL: "off", ...env } });   // off: a check never reaches a real bridge
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	child.on("close", (status) => resolve({ status, stdout, stderr, out, report: () => JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")) }));
});
const r = await run({});
const out = r.out;
assert.equal(r.status, 2, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
const report = r.report();
assert.equal(report.place, "90044978600719");
assert.equal(report.placeVersion, 42);
assert.equal(report.errors.length, 1, "the seeded error is one group");
const [err] = report.errors;
assert.equal(err.count, 2);
assert.equal(err.fingerprint, "ServerScriptService.Shop.Buy:#: attempt to index nil with 'X'");
assert.deepEqual(err.trace, ["Script 'ServerScriptService.Shop.Buy', Line 105 - function buy"]);
assert.equal(err.side, "server");
assert.equal(err.firstStep, 1);
assert.ok(err.actionsBefore.length >= 1 && err.actionsBefore[0].action.kind === "click", "the trace before first sight");
assert.ok(fs.existsSync(path.join(out, err.screenshot)), `screenshot ${err.screenshot}`);
assert.equal(report.console.warnings, 1);
assert.ok(report.stuck.length >= 1, "the stuck detector fires on the frozen mock");
assert.equal(report.stuck[0].actions.length, 5);
assert.equal(report.stuck[0].step, 10);   // console freezes after step 5; five unchanged steps follow
assert.deepEqual(report.gui.clicked, ["LocalPlayer.PlayerGui.ShopGui.Frame.BuyButton", "LocalPlayer.PlayerGui.HUD.MenuButton"]);
assert.deepEqual(report.actions.slice(0, 4).map((h) => h.action.kind), ["click", "click", "interact", "interact"]);
assert.ok(report.actions.slice(4).every((h) => h.action.kind === "walk"));
assert.ok(fs.existsSync(path.join(out, "step-10.png")));
const md = fs.readFileSync(path.join(out, "report.md"), "utf8");
assert.ok(md.includes("## Errors (1)") && md.includes("2× ServerScriptService.Shop.Buy:105") && md.includes("## Stuck (1)"));
const ingest = JSON.parse(fs.readFileSync(path.join(out, "aqua-ingest.json"), "utf8"));
assert.equal(ingest.placeId, 90044978600719);
assert.equal(ingest.messages.length, 1);
assert.deepEqual(Object.keys(ingest.messages[0]).sort(), ["c", "d", "e", "id", "p", "t", "u"]);
assert.equal(ingest.messages[0].e.s, "server");
assert.match(r.stdout, /Play stopped/);

const stepsLog = fs.readFileSync(path.join(out, "stepsLog.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
assert.equal(stepsLog.length, report.steps, "one stepsLog line per step");
assert.deepEqual(Object.keys(stepsLog[0]).sort(), ["action", "done", "errorGroups", "newLines", "notes", "outcome", "screenshot", "step", "stuck", "suspect"]);
assert.equal(stepsLog[0].errorGroups, 1);
assert.equal(stepsLog[9].screenshot, "step-10.png");

// the seat held by another client is a runner failure, not a finding
const taken = await run({ PARLAY_QA_MOCK_SEAT: "taken" });
assert.equal(taken.status, 1, taken.stdout);
assert.match(taken.stdout, /seat taken/i);

// ---- the Chrrxs fallback -------------------------------------------------------------------------------------
// The built-in seat taken (the mock's PARLAY_QA_MOCK_SEAT) and a mock Chrrxs bridge on a local port answering the
// shapes @chrrxs/robloxstudio-mcp 3.1.5 sends: /health without a token, then /mcp/<tool> with X-MCP-Auth. The run
// must go through the bridge end to end: instances → the studio, solo_playtest start, both eval realms, clicks by
// viewport pixel, key press/release, runtime logs by cursor, a png capture, and stop on the way out.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const bridgeCalls = [];
let logRead = 0, playing = false;
const bridge = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => { body += d; });
	req.on("end", () => {
		const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
		const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
		if (req.url === "/health") return send(200, { status: "ok", pluginConnected: true, instanceCount: 1, version: "3.1.5" });
		if (req.headers["x-mcp-auth"] !== "test-token") return send(401, { error: "unauthorized" });
		const tool = req.url.replace(/^\/mcp\//, ""), args = JSON.parse(body || "{}");
		bridgeCalls.push({ tool, args });
		switch (tool) {
			case "get_connected_instances": return send(200, text({ instances: [{ id: "inst-1", placeId: "90044978600719", placeName: "Final Eclipse Testing", peers: { edit: ["p1"] } }], multiplayerGroups: [] }));
			case "solo_playtest":
				if (args.action === "status") return send(200, { success: true, action: "status", running: playing, roles: playing ? ["edit", "server", "client-1"] : ["edit"] });   // the structured body alone
				playing = args.action === "start";
				return send(200, text({ success: true, action: args.action, message: playing ? "Playtest started." : "Playtest stopped." }));
			case "eval_server_runtime": return send(200, text({ success: true, returnValue: fs.readFileSync(path.join(here, "fixtures", "probe-server.json"), "utf8"), output: [] }));
			case "eval_client_runtime": return send(200, text({ success: true, returnValue: /PARLAY_QA_PROBE client/.test(args.code) ? fs.readFileSync(path.join(here, "fixtures", "probe-client.json"), "utf8") : "arrived", output: [] }));
			case "get_runtime_logs": {   // like the mock: two more lines each read; a cursor continues from the last one
				const upto = Math.min(lines.length, ++logRead * 2), from = args.cursor ? Number(args.cursor.slice(1)) : 0;
				return send(200, text({ instanceId: "inst-1", entries: lines.slice(from, upto).map((message, i) => ({ seq: from + i, ts: 0, level: "info", message })), nextCursor: `c${upto}` }));
			}
			case "capture_screenshot": return send(200, { content: [{ type: "text", text: JSON.stringify({ width: 1, height: 1, format: "png" }) }, { type: "image", data: PNG_1PX, mimeType: "image/png" }] });
			case "simulate_keyboard_input": case "simulate_mouse_input": return send(200, text({ success: true }));
			default: return send(500, { error: `Unknown tool: ${tool}` });
		}
	});
});
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
const viaBridge = await run({ PARLAY_QA_MOCK_SEAT: "taken", PARLAY_QA_CHRRXS_URL: bridgeUrl, ROBLOX_STUDIO_AUTH_TOKEN: "test-token" });
assert.equal(viaBridge.status, 2, viaBridge.stdout);
assert.match(viaBridge.stdout, /switching to the Chrrxs bridge/);
const bridged = viaBridge.report();
assert.equal(bridged.transport, "chrrxs");
assert.equal(bridged.studio.id, "inst-1");
assert.ok(bridged.steps >= 12, `only ${bridged.steps} steps through the bridge`);   // the 12 s budget, with the walks' real waits
assert.equal(bridged.errors.length, 1, "the seeded error group arrives through get_runtime_logs");
assert.deepEqual(bridgeCalls.slice(0, 3).map((c) => c.tool), ["get_connected_instances", "solo_playtest", "solo_playtest"]);   // list, the state log, start
assert.deepEqual(bridgeCalls[2].args, { action: "start", mode: "play", timeout: 60, instance_id: "inst-1" });
assert.ok(bridgeCalls.some((c) => c.tool === "eval_server_runtime" && c.args.instance_id === "inst-1" && /PARLAY_QA_PROBE server/.test(c.args.code)));
assert.ok(bridgeCalls.some((c) => c.tool === "eval_client_runtime" && c.args.target === "client-1"));
assert.deepEqual(bridgeCalls.find((c) => c.tool === "simulate_mouse_input").args, { action: "click", x: 640, y: 400, target: "client-1", instance_id: "inst-1" }, "the Buy button by its probe pixels");
const keys = bridgeCalls.filter((c) => c.tool === "simulate_keyboard_input").map((c) => `${c.args.keyCode}:${c.args.action}`);
assert.ok(keys.some((k) => /^[WASD]:press$/.test(k)) && keys.some((k) => /^[WASD]:release$/.test(k)) && keys.includes("Space:tap"), keys.join(" "));
assert.ok(bridgeCalls.some((c) => c.tool === "get_runtime_logs" && c.args.cursor), "later log reads continue from the cursor");
assert.ok(bridgeCalls.some((c) => c.tool === "capture_screenshot" && c.args.format === "png"));
assert.deepEqual(bridgeCalls.at(-1), { tool: "solo_playtest", args: { action: "stop", timeout: 15, instance_id: "inst-1" } });
assert.ok(fs.readdirSync(viaBridge.out).some((f) => f.endsWith(".png")), "a png landed through the bridge");
// a wrong token is a runner failure that names the token, not a hang
const badToken = await run({ PARLAY_QA_MOCK_SEAT: "taken", PARLAY_QA_CHRRXS_URL: bridgeUrl, ROBLOX_STUDIO_AUTH_TOKEN: "wrong" });
assert.equal(badToken.status, 1, badToken.stdout);
assert.match(badToken.stdout, /rejected the token/);
bridge.close();

// ---- the Jev policy against a mock TypeSafe -----------------------------------------------------------------
// Answers the exact shape the live POST /v1/systemone gave on 2026-09-20 (model pinned, noul answers carry only
// noul, choice answers carry choice, confidence, probabilities): picks click_1 (the second button; the scripted
// policy would take the first) while offered, else walk_S; "stuck" high once five steps changed nothing (step 11 on),
// "looks wrong" high at two unchanged steps (step 8, no console error: the suspect) and from five on (no suspect:
// those are the stuck event). A key other than "good" gets a 401. Nothing here reaches the real API.
const seen = [];
const jev = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => { body += d; });
	req.on("end", () => {
		if (req.headers.authorization !== "Bearer good") { res.writeHead(401); res.end("{}"); return; }
		const b = JSON.parse(body);
		seen.push(b);
		const offered = Object.keys(b.questions.next.criteria);
		const choice = ["click_1", "walk_S", "click_0", "interact_0", "interact_1", "explore"].find((k) => offered.includes(k)) ?? offered[0];
		const noul = (p) => ({ type: "noul", noul: p });
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ model: "jev-1.13.0", answers: {
			next: { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(offered.map((k) => [k, k === choice ? 0.6 : 0.4 / (offered.length - 1)])) },
			stuck: noul((b.state.stepsWithoutChange ?? 0) >= 5 ? 0.9 : 0.1), noEffect: noul(0.2), looksWrong: noul([2, 5].includes(b.state.stepsWithoutChange) ? 0.9 : 0.1),
			done: noul(b.questions.deadButton && b.state.tried?.buttons === "2 of 2" ? 0.9 : 0.1),
			...(b.questions.deadButton ? { deadButton: noul(/^click/.test(b.state.lastActions?.at(-1) ?? "") ? 0.9 : 0.1) } : {}),
		}, usage: { input_tokens: 443, output_tokens: 61 } }));
	});
});
await new Promise((res) => jev.listen(0, "127.0.0.1", res));
const jevEnv = { PARLAY_QA_JEV_URL: `http://127.0.0.1:${jev.address().port}` };

const j = await run({ ...jevEnv, PARLAY_TYPESAFE_API_KEY: "good" }, "--policy", "jev");
assert.equal(j.status, 2, `exit ${j.status}\n${j.stdout}\n${j.stderr}`);
const jr = j.report();
assert.equal(jr.policy, "jev");
// the first request: the model, a compact state, the choice over every offered action and the three flags
assert.ok(seen.length, `no request reached the mock:\n${j.stdout}`);
assert.equal(seen[0].model, "jev-latest");
assert.deepEqual(seen[0].state.buttonsOnScreen, ["Buy", "Menu"]);
assert.deepEqual(seen[0].state.interactablesNearby, ["ProximityPrompt Prompt at 8 studs", "ClickDetector ClickDetector at 16 studs"]);
assert.equal(seen[0].state.stepsWithoutChange, 0);
assert.deepEqual(seen[0].state.tried, { buttons: "0 of 2", interactables: "0 of 2" });
assert.match(seen[0].questions.next.instructions, /as the Explorer/);
assert.deepEqual(Object.keys(seen[0].questions.next.criteria).sort(), ["click_0", "click_1", "interact_0", "interact_1"]);
assert.deepEqual(Object.keys(seen[0].questions).sort(), ["done", "looksWrong", "next", "noEffect", "stuck"]);
assert.ok(Object.values(seen[0].questions).every((q) => q.type === "choice" || (q.type === "noul" && q.criteria.true && q.criteria.false)));
// Jev's choice became the action, with its probabilities and flags on it
const [first, second] = jr.actions;
assert.equal(first.action.kind, "click");
assert.equal(first.action.path, "LocalPlayer.PlayerGui.HUD.MenuButton", "click_1 is the second button");
assert.equal(first.action.jev.probabilities.click_1, 0.6);
assert.deepEqual(first.action.jev.flags, { stuck: 0.1, noEffect: 0.2, looksWrong: 0.1, done: 0.1 });
assert.equal(first.action.jev.confidence, 0.8);
assert.deepEqual([second.action.kind, second.action.text], ["click", "Buy"], "click_0 next: walks are not offered while buttons are untried");
assert.deepEqual(jr.actions.slice(2, 4).map((h) => h.action.kind), ["interact", "interact"], "then the two untried interactables");
assert.ok(jr.actions.slice(4).every((h) => h.action.kind === "walk" && h.action.key === "S"), "walk_S once nothing untried is left");
assert.ok(!Object.keys(seen[0].questions.next.criteria).some((k) => k.startsWith("walk_") || k === "explore"), "no walks offered while buttons and interactables are untried");
// once stuck, only walks are offered and the identical state is answered from the cache, not the mock
const stuckReq = seen.find((b) => b.state.stepsWithoutChange >= 5);
assert.ok(stuckReq && Object.keys(stuckReq.questions.next.criteria).every((k) => k === "explore" || k.startsWith("walk_")));
assert.ok(seen.length < jr.steps, `${seen.length} requests for ${jr.steps} steps: the cache answered the frozen steps`);
// the suspect: step 8 (two unchanged steps, the console froze at step 5, so no error accompanies it); the frozen steps from 11 on are the stuck event, not suspects
assert.equal(jr.suspects.length, 1, "one suspect; stuck steps are not suspects");
assert.equal(jr.suspects[0].step, 8);
assert.equal(jr.suspects[0].probability, 0.9);
assert.equal(jr.suspects[0].screenshot, "suspect-step-8.png");
assert.ok(fs.existsSync(path.join(j.out, "suspect-step-8.png")));
assert.equal(jr.suspects[0].actionsBefore.length, 5);
assert.equal(jr.errors.length, 1, "the console error is still one group, not a suspect");
const jmd = fs.readFileSync(path.join(j.out, "report.md"), "utf8");
assert.ok(jmd.includes(`## Suspects (${jr.suspects.length})`) && jmd.includes("### step 8: 90% looks wrong; screenshot suspect-step-8.png"));
assert.ok(!md.includes("## Suspects"), "the scripted report has no suspects section");
assert.match(j.stdout, /jev wrong 0\.90; suspect/);
assert.ok(!j.stdout.includes("good"), "the key stays out of the log");

// a refused key: one log line, the scripted policy for the rest of the run, no jev on the actions
const bad = await run({ ...jevEnv, PARLAY_TYPESAFE_API_KEY: "bad" }, "--policy", "jev");
assert.equal(bad.status, 2, bad.stdout);
const br = bad.report();
assert.deepEqual(br.actions.slice(0, 4).map((h) => h.action.kind), ["click", "click", "interact", "interact"]);
assert.equal(br.actions[0].action.path, "LocalPlayer.PlayerGui.ShopGui.Frame.BuyButton", "the scripted policy's first button");
assert.ok(br.actions.every((h) => !h.action.jev));
assert.equal(br.suspects.length, 0);
assert.equal((bad.stdout.match(/jev: HTTP 401/g) ?? []).length, 1, `logged once:\n${bad.stdout}`);
assert.match(bad.stdout, /scripted policy for the rest of the run/);

// --stop-file: the QA view's Stop; present before the run starts, so the loop ends before its first step
const stopFile = path.join(tmp, "stop");
fs.writeFileSync(stopFile, "");
const stopped = await run({}, "--stop-file", stopFile);
assert.equal(stopped.status, 0, stopped.stdout);
assert.equal(stopped.report().steps, 0);
assert.match(stopped.stdout, /stop file seen/);
assert.match(stopped.stdout, /Play stopped/);

fs.rmSync(tmp, { recursive: true, force: true });
// ---- the UI tester agent ---------------------------------------------------------------------------------------
// Offered clicks and explore only, notes every click the mock calls dead, and ends the session itself: done 0.9
// once both buttons are tried, so three agreeing steps after the minimum of eight end it well before the 30-step cap.
const ui = await run({ ...jevEnv, PARLAY_TYPESAFE_API_KEY: "good" }, "--policy", "jev", "--agent", "ui");
const ur = ui.report();
assert.equal(ur.agent, "ui");
assert.equal(ur.doneBy, "jev", `ended by ${ur.doneBy}: ${ui.stdout.slice(-300)}`);
assert.ok(ur.steps >= 8 && ur.steps < 30, `${ur.steps} steps`);
const uiReq = seen.find((b) => b.questions.deadButton);
assert.ok(uiReq, "the UI tester asks its dead-button question");
assert.deepEqual(Object.keys(uiReq.questions).sort(), ["deadButton", "done", "looksWrong", "next", "noEffect", "stuck"]);
assert.ok(Object.keys(uiReq.questions.next.criteria).every((k) => k.startsWith("click_") || k === "explore"), "clicks and explore only");
assert.deepEqual(ur.actions.slice(0, 2).map((h) => [h.action.kind, h.action.text]), [["click", "Menu"], ["click", "Buy"]]);
assert.ok(ur.notes.length >= 2 && ur.notes.every((n) => n.kind === "dead-button" && /did nothing when clicked/.test(n.text) && n.probability === 0.9), JSON.stringify(ur.notes));
assert.equal(ur.notes[0].screenshot, "note-dead-button-step-2.png");
assert.ok(fs.existsSync(path.join(ui.out, "note-dead-button-step-2.png")));
assert.ok(fs.readFileSync(path.join(ui.out, "report.md"), "utf8").includes(`## Notes (${ur.notes.length})`));
assert.match(ui.stdout, /the ui agent says this session is done/);
assert.equal(jr.doneBy, "exhausted", "the Explorer above ran out of untried targets with nothing new appearing, and ended itself");

jev.close();
console.log(`qa-check: ok (${report.steps} mock steps, ${report.errors.length} error group ×${err.count}, ${report.stuck.length} stuck; jev: ${seen.length} requests, ${jr.suspects.length} suspects, 401 fallback; chrrxs: ${bridgeCalls.length} bridge calls, bad token; ui agent: ${ur.steps} steps, ${ur.notes.length} notes, done by ${ur.doneBy})`);
