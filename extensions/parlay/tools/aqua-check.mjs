// The one check for the Aqua issues text logic: node --no-warnings tools/aqua-check.mjs   (node 24 runs the .ts as is)
import assert from "node:assert/strict";
import { applyHunks, candidates, firstLoc, linkify, locate, mirrorCandidates, parseDiff, shortLoc } from "../src/aquaText.ts";

// the two ways Roblox names a script and a line (Aqua's tests carry both)
assert.deepEqual(firstLoc("ServerScriptService.Shop.Buy:105: attempt to index nil with 'Price'"), { path: ["ServerScriptService", "Shop", "Buy"], line: 105 });
assert.deepEqual(firstLoc("Script 'ServerScriptService.UserGenerated.Analytics.PlayerKit', Line 650"), { path: ["ServerScriptService", "UserGenerated", "Analytics", "PlayerKit"], line: 650 });
assert.deepEqual(firstLoc("Script ServerScriptService.Shop, Line 105"), { path: ["ServerScriptService", "Shop"], line: 105 });
assert.deepEqual(firstLoc(undefined, "no script here", "game.ReplicatedStorage.Util:3: boom"), { path: ["ReplicatedStorage", "Util"], line: 3 });
// a client path is folded back to the Starter container Script Sync mirrors
assert.deepEqual(firstLoc("Players.<player>.PlayerScripts.Hud:12: x"), { path: ["StarterPlayer", "StarterPlayerScripts", "Hud"], line: 12 });
assert.deepEqual(firstLoc("Players.Dave.PlayerGui.Shop.Frame.Click:9: x").path, ["StarterGui", "Shop", "Frame", "Click"]);
// a stack: every frame, in order, and a timestamp is not a script
assert.deepEqual(locate("[Error] 2026-09-17T10:30:05 ServerScriptService.A:1: x\n  Script 'ServerScriptService.B', Line 2\n  ServerScriptService.C:3").map((h) => `${h.path.join(".")}:${h.line}`),
	["ServerScriptService.A:1", "ServerScriptService.B:2", "ServerScriptService.C:3"]);
assert.equal(shortLoc({ path: ["ServerScriptService", "Shop", "Buy"], line: 105 }), "Shop.Buy:105");
assert.equal(linkify("at ServerScriptService.Shop.Buy:105 <ok>"), `at <a class="goto" data-goto="ServerScriptService.Shop.Buy|105">ServerScriptService.Shop.Buy:105</a> &lt;ok&gt;`);

// Script Sync files an instance can be, most likely first; StarterPlayer children both nested and top-level
assert.deepEqual(candidates(["ServerScriptService", "Shop", "Buy"]).slice(0, 4),
	["ServerScriptService/Shop/Buy.server.luau", "ServerScriptService/Shop/Buy.client.luau", "ServerScriptService/Shop/Buy.luau", "ServerScriptService/Shop/Buy/init.server.luau"]);
assert.ok(candidates(["StarterPlayer", "StarterPlayerScripts", "Hud"]).includes("StarterPlayerScripts/Hud.client.luau"));
assert.deepEqual(mirrorCandidates("StarterPlayer/StarterPlayerScripts/Hud.client.luau"), ["StarterPlayer/StarterPlayerScripts/Hud.client.luau", "StarterPlayerScripts/Hud.client.luau"]);

// a git diff as Aqua stores it: one changed file, one new file
const diff = [
	"diff --git a/ServerScriptService/Shop/Buy.server.luau b/ServerScriptService/Shop/Buy.server.luau",
	"index 1111111..2222222 100644",
	"--- a/ServerScriptService/Shop/Buy.server.luau",
	"+++ b/ServerScriptService/Shop/Buy.server.luau",
	"@@ -2,3 +2,4 @@ local function buy(player, item)",
	" \tlocal price = item.Price",
	"-\tplayer.Coins.Value -= price",
	"+\tif price == nil then return end",
	"+\tplayer.Coins.Value -= price",
	" end",
	"diff --git a/ReplicatedStorage/New.luau b/ReplicatedStorage/New.luau",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/ReplicatedStorage/New.luau",
	"@@ -0,0 +1,2 @@",
	"+local M = {}",
	"+return M",
	"\\ No newline at end of file",
].join("\n");
const files = parseDiff(diff);
assert.equal(files.length, 2);
assert.equal(files[0].path, "ServerScriptService/Shop/Buy.server.luau");
assert.equal(files[0].hunks[0].oldStart, 2);
assert.equal(files[0].hunks[0].lines.length, 5);
assert.ok(files[1].created && !files[1].deleted);
// applies at its line, follows the file when it moved, refuses when the code under it changed, keeps CRLF
const buy = "local function buy(player, item)\n\tlocal price = item.Price\n\tplayer.Coins.Value -= price\nend\n";
assert.equal(applyHunks(buy, files[0].hunks), "local function buy(player, item)\n\tlocal price = item.Price\n\tif price == nil then return end\n\tplayer.Coins.Value -= price\nend\n");
assert.equal(applyHunks("-- header\n-- more\n" + buy, files[0].hunks), "-- header\n-- more\nlocal function buy(player, item)\n\tlocal price = item.Price\n\tif price == nil then return end\n\tplayer.Coins.Value -= price\nend\n");
assert.equal(applyHunks(buy.replace("-= price", "-= price * 2"), files[0].hunks), 1);
assert.equal(applyHunks(buy.replace(/\n/g, "\r\n"), files[0].hunks).split("\r\n").length, 6);
assert.equal(applyHunks("", files[1].hunks), "local M = {}\nreturn M\n");

console.log("aqua-check: ok");
