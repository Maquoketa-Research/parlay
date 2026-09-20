// The one check for the QA play runner: node --no-warnings qa/qa-check.mjs
// The console classifier and fingerprint on the fixture lines, then a whole play against the mock MCP
// (PARLAY_QA_MCP=mock): the seeded error grouped once with its trace, the stuck detector firing on the frozen
// state, exit 2; and exit 1 when the mock says the seat is taken.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

// a whole play against the mock
const out = fs.mkdtempSync(path.join(os.tmpdir(), "parlay-qa-"));
const run = (env) => spawnSync(process.execPath, [path.join(here, "play.mjs"), "--place", "90044978600719", "--minutes", "0.05", "--steps", "30", "--pace-ms", "0", "--out", out],
	{ env: { ...process.env, PARLAY_QA_MCP: "mock", ...env }, encoding: "utf8" });
const r = run({});
assert.equal(r.status, 2, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
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

// the seat held by another client is a runner failure, not a finding
const taken = run({ PARLAY_QA_MOCK_SEAT: "taken" });
assert.equal(taken.status, 1, taken.stdout);
assert.match(taken.stdout, /seat taken/i);

fs.rmSync(out, { recursive: true, force: true });
console.log(`qa-check: ok (${report.steps} mock steps, ${report.errors.length} error group ×${err.count}, ${report.stuck.length} stuck)`);
