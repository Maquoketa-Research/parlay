// Version sweep without file dialogs: open a past version of a place in Studio, read its tree with read-only Luau
// through the Chrrxs bridge, write one JSON per version, close the session by pid. Nothing here can write to Roblox:
// no Publish, no SavePlaceAsync, no Restore, no Game Settings; the only writes are the JSON files below.
//
//   node qa/revision-extract.mjs --place 88929721329145 --universe 10766831613 --versions 3,5
//   node qa/revision-extract.mjs --place ... --universe ... --from 1 --to 40 --step 5 [--out DIR] [--chunk 120000]
//
// Facts this relies on (live-checked 2026-09-21 on Aqua Multi-Place Testing, docs/bladeball-data-prep.md section 4):
//   - `RobloxStudioBeta.exe --task EditPlaceRevision --placeVersion N` opens the version in a new window in ~12 s;
//   - that session reads PlaceId 0 and PlaceVersion 0 and is named "<PlaceName> (Version N)", so the window is found
//     by "bridge id that was not connected before the launch", never by name, and the version is checked in the name;
//   - Studio's main window honours the launcher's hide flag, so the process is spawned without `windowsHide`;
//   - the plugin caps one result at ~200 KB, so big services are pulled in chunks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { connect } from "./chrrxs.mjs";

const a = Object.fromEntries(process.argv.slice(2).map((s, i, all) => s.startsWith("--") ? [s.slice(2), all[i + 1] ?? ""] : null).filter(Boolean));
if (!a.place || !a.universe || !(a.versions || (a.from && a.to))) {
	console.error("usage: revision-extract --place ID --universe ID (--versions 1,2,3 | --from A --to B [--step S]) [--out DIR] [--chunk BYTES]");
	process.exit(64);
}
const versions = a.versions ? a.versions.split(",").map(Number) : Array.from({ length: Math.floor((+a.to - +a.from) / (+a.step || 1)) + 1 }, (_, i) => +a.from + i * (+a.step || 1));
const OUT = a.out ?? path.join(os.homedir(), "Documents", "Parlay", "data", "versions", a.place);
const EXE = a.exe ?? path.join(process.env.LOCALAPPDATA, "Roblox", "Versions", "version-55808de4b1914919", "RobloxStudioBeta.exe");
let CHUNK = +a.chunk || 120000;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...m) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s`, ...m);

const mcp = await connect({ timeoutMs: 30000 });
const studios = () => mcp.call("list_roblox_studios").then((r) => JSON.parse(r.text).studios);
const luau = (id, code) => mcp.call("execute_luau", { studio_id: id, datamodel_type: "Edit", code }, 180000).then((r) => r.text.trim());
let child = null;
const stopChild = () => { if (child) try { process.kill(child.pid); } catch {} };
process.on("SIGINT", () => { stopChild(); mcp.close(); process.exit(130); });

// windows reconnect one by one to a fresh bridge: wait until the connected set has been stable for 6 s
let snap = new Set();
for (let stable = 0; stable < 3; await sleep(2000)) {
	const ids = new Set((await studios()).map((s) => s.id));
	if (ids.size === snap.size && [...ids].every((i) => snap.has(i))) stable++; else { snap = ids; stable = 0; }
}
log(`bridge sees ${snap.size} Studio window(s)`);

const SERVICES = ["Workspace", "ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "Teams", "Chat", "TextChatService", "LocalizationService", "MaterialService"];
// Read-only walk of one service. Names, classes, attributes, script Source, Value, Text, part position/size.
const BUILD = (service) => `local H = game:GetService("HttpService")
local rows = {}
local function walk(inst, p)
	local row = { p = p, c = inst.ClassName }
	local ok, attrs = pcall(function() return inst:GetAttributes() end)
	if ok and next(attrs) then row.a = attrs end
	if inst:IsA("LuaSourceContainer") then
		local okS, src = pcall(function() return inst.Source end)
		if okS then row.src = src end
		if inst:IsA("BaseScript") then row.on = inst.Enabled end
	elseif inst:IsA("ValueBase") then
		local okV, v = pcall(function() return inst.Value end)
		if okV then row.v = tostring(v) end
	elseif inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
		row.t = inst.Text
	elseif inst:IsA("BasePart") then
		local P, S = inst.Position, inst.Size
		row.pos = { math.floor(P.X * 10) / 10, math.floor(P.Y * 10) / 10, math.floor(P.Z * 10) / 10 }
		row.size = { math.floor(S.X * 10) / 10, math.floor(S.Y * 10) / 10, math.floor(S.Z * 10) / 10 }
	end
	rows[#rows + 1] = row
	for _, ch in ipairs(inst:GetChildren()) do walk(ch, p .. "/" .. ch.Name) end
end
local root = game:GetService(${JSON.stringify(service)})
for _, ch in ipairs(root:GetChildren()) do walk(ch, root.Name .. "/" .. ch.Name) end
local s = H:JSONEncode(rows)
_G.__parlayExtract = s`;
// one JSON per service, pulled in chunks; the stash is recomputed if the plugin VM dropped _G between calls
async function pull(id, service) {
	const total = Number(await luau(id, `${BUILD(service)}\nreturn #s`));
	if (!Number.isFinite(total)) throw new Error(`${service}: could not size the result`);
	let out = "";
	while (out.length < total) {
		const from = out.length + 1, want = Math.min(CHUNK, total - out.length);
		const piece = await luau(id, `if not _G.__parlayExtract then\n${BUILD(service)}\nend\nreturn string.sub(_G.__parlayExtract, ${from}, ${from + want - 1})`);
		if (piece.length !== want) {
			if (piece.length > want || CHUNK < 4000) throw new Error(`${service}: chunk of ${want} came back as ${piece.length} bytes`);
			CHUNK = Math.floor(CHUNK / 2); log(`${service}: chunk came back short; retrying at ${CHUNK} bytes`); continue;
		}
		out += piece;
	}
	await luau(id, `_G.__parlayExtract = nil return "ok"`);
	return JSON.parse(out);
}

const done = [], skipped = [];
for (const N of versions) {
	const file = path.join(OUT, `v${N}.json`);
	if (fs.existsSync(file)) { skipped.push(N); continue; }
	const tv = Date.now();
	child = spawn(EXE, ["--task", "EditPlaceRevision", "--placeId", a.place, "--universeId", a.universe, "--placeVersion", String(N)], { detached: true, stdio: "ignore" });
	child.unref();
	let fresh = null;
	for (const t = Date.now(); Date.now() - t < 300000 && !fresh; await sleep(2000)) {
		const now = (await studios()).filter((s) => !snap.has(s.id));
		if (now.length > 1) { log(`v${N}: two new windows appeared (${now.map((s) => s.name).join(" | ")}); stopping so nothing is read from the wrong one`); stopChild(); mcp.close(); process.exit(2); }
		if (now.length === 1) fresh = now[0];
	}
	if (!fresh) { log(`v${N}: the revision window never connected within 5 min; stopping`); stopChild(); mcp.close(); process.exit(2); }
	await sleep(3000);
	const stamp = JSON.parse(await luau(fresh.id, `local H = game:GetService("HttpService")
return H:JSONEncode({ placeId = game.PlaceId, placeVersion = game.PlaceVersion, name = game.Name, edit = game:GetService("RunService"):IsEdit() })`));
	const named = Number(/\(Version (\d+)\)\s*$/.exec(stamp.name)?.[1]);
	if (named !== N || !stamp.edit) { log(`v${N}: session is "${stamp.name}" (edit=${stamp.edit}); expected "(Version ${N})" in edit mode; stopping`); stopChild(); mcp.close(); process.exit(4); }
	const data = { placeId: a.place, universeId: a.universe, version: N, stamp, extractedAt: new Date().toISOString(), services: {} };
	let rows = 0;
	for (const svc of SERVICES) { data.services[svc] = await pull(fresh.id, svc); rows += data.services[svc].length; }
	fs.writeFileSync(file, JSON.stringify(data));
	stopChild();
	for (const t = Date.now(); Date.now() - t < 30000; await sleep(1000)) if (!(await studios()).some((s) => s.id === fresh.id)) break;
	child = null;
	log(`v${N}: ${rows} instances, ${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${((Date.now() - tv) / 1000).toFixed(0)} s → ${file}`);
	done.push(N);
}
log(`done: ${done.length} extracted${skipped.length ? `, ${skipped.length} already on disk (${skipped.join(",")})` : ""}; nothing was saved to Roblox`);
mcp.close();
