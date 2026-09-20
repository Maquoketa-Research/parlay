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
		{ env: { ...process.env, PARLAY_QA_MCP: "mock", PARLAY_QA_POLICY: "", PARLAY_TYPESAFE_API_KEY: "", ...env } });
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
assert.deepEqual(Object.keys(stepsLog[0]).sort(), ["action", "errorGroups", "newLines", "outcome", "screenshot", "step", "stuck"]);
assert.equal(stepsLog[0].errorGroups, 1);
assert.equal(stepsLog[9].screenshot, "step-10.png");

// the seat held by another client is a runner failure, not a finding
const taken = await run({ PARLAY_QA_MOCK_SEAT: "taken" });
assert.equal(taken.status, 1, taken.stdout);
assert.match(taken.stdout, /seat taken/i);

// ---- the Jev policy against a mock TypeSafe -----------------------------------------------------------------
// Answers the exact shape the live POST /v1/systemone gave on 2026-09-20 (model pinned, noul answers carry only
// noul, choice answers carry choice, confidence, probabilities): picks click_1 (the second button; the scripted
// policy would take the first) while offered, else walk_S; "looks wrong" and "stuck" high only once the runner
// says the player is stuck (from step 11 on), so the suspect lands on a step without a console error. A key
// other than "good" gets a 401. Nothing here reaches the real API.
const seen = [];
const jev = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => { body += d; });
	req.on("end", () => {
		if (req.headers.authorization !== "Bearer good") { res.writeHead(401); res.end("{}"); return; }
		const b = JSON.parse(body);
		seen.push(b);
		const offered = Object.keys(b.questions.next.criteria);
		const choice = offered.includes("click_1") ? "click_1" : "walk_S";
		const noul = (p) => ({ type: "noul", noul: p });
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ model: "jev-1.13.0", answers: {
			next: { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(offered.map((k) => [k, k === choice ? 0.6 : 0.4 / (offered.length - 1)])) },
			stuck: noul(b.state.stuck ? 0.9 : 0.1), noEffect: noul(0.2), looksWrong: noul(b.state.stuck ? 0.9 : 0.1),
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
assert.equal(seen[0].state.stuck, false);
assert.deepEqual(Object.keys(seen[0].questions.next.criteria).sort(), ["click_0", "click_1", "explore", "interact_0", "interact_1", "walk_A", "walk_D", "walk_S", "walk_W"]);
assert.deepEqual(Object.keys(seen[0].questions).sort(), ["looksWrong", "next", "noEffect", "stuck"]);
assert.ok(Object.values(seen[0].questions).every((q) => q.type === "choice" || (q.type === "noul" && q.criteria.true && q.criteria.false)));
// Jev's choice became the action, with its probabilities and flags on it
const [first, second] = jr.actions;
assert.equal(first.action.kind, "click");
assert.equal(first.action.path, "LocalPlayer.PlayerGui.HUD.MenuButton", "click_1 is the second button");
assert.equal(first.action.jev.probabilities.click_1, 0.6);
assert.deepEqual(first.action.jev.flags, { stuck: 0.1, noEffect: 0.2, looksWrong: 0.1 });
assert.equal(first.action.jev.confidence, 0.8);
assert.deepEqual([second.action.kind, second.action.key, second.action.jump], ["walk", "S", true]);
assert.ok(jr.actions.slice(1).every((h) => h.action.kind === "walk" && h.action.key === "S"), "walk_S once click_1 is used up");
// once stuck, only walks are offered and the identical state is answered from the cache, not the mock
const stuckReq = seen.find((b) => b.state.stuck);
assert.ok(stuckReq && Object.keys(stuckReq.questions.next.criteria).every((k) => k === "explore" || k.startsWith("walk_")));
assert.ok(seen.length < jr.steps, `${seen.length} requests for ${jr.steps} steps: the cache answered the frozen steps`);
// the suspect: step 11 is the first the runner calls stuck, the console froze at step 5, so no error accompanies it
assert.ok(jr.suspects.length >= 1, "a suspect finding");
assert.equal(jr.suspects[0].step, 11);
assert.equal(jr.suspects[0].probability, 0.9);
assert.equal(jr.suspects[0].screenshot, "suspect-step-11.png");
assert.ok(fs.existsSync(path.join(j.out, "suspect-step-11.png")));
assert.equal(jr.suspects[0].actionsBefore.length, 5);
assert.equal(jr.errors.length, 1, "the console error is still one group, not a suspect");
const jmd = fs.readFileSync(path.join(j.out, "report.md"), "utf8");
assert.ok(jmd.includes(`## Suspects (${jr.suspects.length})`) && jmd.includes("### step 11: 90% looks wrong; screenshot suspect-step-11.png"));
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
jev.close();

// --stop-file: the QA view's Stop; present before the run starts, so the loop ends before its first step
const stopFile = path.join(tmp, "stop");
fs.writeFileSync(stopFile, "");
const stopped = await run({}, "--stop-file", stopFile);
assert.equal(stopped.status, 0, stopped.stdout);
assert.equal(stopped.report().steps, 0);
assert.match(stopped.stdout, /stop file seen/);
assert.match(stopped.stdout, /Play stopped/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`qa-check: ok (${report.steps} mock steps, ${report.errors.length} error group ×${err.count}, ${report.stuck.length} stuck; jev: ${seen.length} requests, ${jr.suspects.length} suspects, 401 fallback)`);
