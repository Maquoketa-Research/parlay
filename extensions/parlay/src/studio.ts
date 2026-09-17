// Roblox Studio as the starting point. "Add Roblox Studio project" lists the Studios that are open (through
// Roblox's own Studio MCP server), and for the one you pick: finds the folder Studio already syncs it to (from
// Studio's Script Sync records in the registry) or makes one, wires git (clone the org's repo if it exists,
// otherwise init and point origin at it), and opens the folder in Parlay. Studio exposes Script Sync to plugins
// read-only (InstanceFileSyncService: GetStatus, GetAllInstances, StatusChanged), so the one thing that stays
// a click in Studio is choosing the folder; Parlay puts the path on the clipboard and says where to click.
import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readPlaceIds } from "./rbxl";
import { SCOPES as ROBLOX_SCOPES } from "./roblox-auth";

export interface Studio { id: string; name: string; placeId: string; detail?: string; universeId?: string }

import { log } from "./log";
export { log };   // the other modules still import it from here
const cfg = <T>(k: string, d: T): T => vscode.workspace.getConfiguration("parlay").get<T>(k, d);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "place";

// ---- the Studio MCP server (stdio JSON-RPC), one short session per use ------------------------------------
// The seat is exclusive per machine: while Claude Code (or another client) holds it, this fails fast.

type Call = (method: string, params: unknown) => Promise<any>;

export function studioSession<T>(fn: (call: Call) => Promise<T>, timeoutMs = 20000): Promise<T> {
	return new Promise((resolve, reject) => {
		const bat = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "mcp.bat");
		if (!fs.existsSync(bat)) return reject(new Error("Roblox Studio MCP not installed (expected %LOCALAPPDATA%\\Roblox\\mcp.bat)"));
		const child = spawn("cmd.exe", ["/d", "/s", "/c", bat], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
		let buf = ""; let nextId = 1; const pending = new Map<number, (v: any) => void>();
		const call: Call = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
		// kill the tree: child is cmd.exe, and killing only it leaves StudioMCP.exe running forever
		const done = (err?: Error, value?: T) => { clearTimeout(t); if (child.pid) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { }); err ? reject(err) : resolve(value as T); };
		const t = setTimeout(() => done(new Error("Studio MCP timed out; is another client (Claude Code) connected to Studio?")), timeoutMs);
		child.on("error", (e) => done(e));
		child.stdout.on("data", (d) => {
			buf += d.toString();
			let i; while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
				if (!line) continue;
				try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); } } catch { /* not json */ }
			}
		});
		(async () => {
			await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "parlay", version: "0.0.5" } });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
			done(undefined, await fn(call));
		})().catch((e) => done(e));
	});
}

// the text of a tool result, whatever shape the server used
export function toolText(result: any): string {
	const content = result?.result?.content ?? [];
	return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || JSON.stringify(result?.result ?? {});
}

// Open places, best source first: the Studio MCP server (names and placeIds), else the Studio windows themselves
// (titles are "Place - Roblox Studio"; no placeId, but no seat needed). The MCP seat is exclusive per machine, so
// while Claude Code is connected to Studio the first source fails and the second carries.
let lastListError = "";

export async function listStudios(): Promise<Studio[]> {
	// the MCP server is the source of truth (instance id and place id straight from Studio); the windows and
	// their logs are the backup, and fill in any window the server did not report
	const t0 = Date.now();
	const [mcp, win] = await Promise.allSettled([listStudiosViaMcp(), listStudiosViaWindows()]);
	const studios: Studio[] = mcp.status === "fulfilled" ? mcp.value : [];
	if (mcp.status === "rejected") log.appendLine(`Studio MCP: ${(mcp.reason as Error).message}`);   // seat taken or server down
	const viaWindows: Studio[] = win.status === "fulfilled" ? win.value : [];
	if (win.status === "rejected") { lastListError = (win.reason as Error).message; log.appendLine(`Studio windows: ${lastListError}`); }
	log.appendLine(`listed Studios in ${Date.now() - t0} ms: mcp ${studios.length}, windows ${viaWindows.map((w) => `${w.name} (${w.placeId || "no place id"})`).join(", ") || "none"}`);
	for (const w of viaWindows) {
		const known = studios.some((s) => (w.placeId && s.placeId === w.placeId) || s.name.toLowerCase() === w.name.toLowerCase());
		if (!known) studios.push(w);
	}
	return studios;
}

// Each Studio window is a process; its log in %LOCALAPPDATA%\Roblox\logs is named with the process start time
// (…_20260916T011322Z_Studio_XXXXX_last.log) and carries "placeid: N" and "universeid: N" near the top. So a
// window title plus a start time gives the place id, offline, for published and unpublished places alike.
async function listStudiosViaWindows(): Promise<Studio[]> {
	if (process.platform !== "win32") return [];
	const out = await powershell("Get-Process -Name RobloxStudioBeta,RobloxStudio -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle + '|' + $_.StartTime.ToUniversalTime().ToString('yyyyMMddTHHmmss') }");
	let logs: ReturnType<typeof studioLogs> = [];
	try { logs = studioLogs(); } catch { /* the windows still list; only the ids are missing */ }
	const seen = new Set<string>();
	const studios: Studio[] = [];
	for (const line of out.split(/\r?\n/).map((t) => t.trim()).filter(Boolean)) {
		const bar = line.lastIndexOf("|");
		const title = line.slice(0, bar), started = stampToMs(line.slice(bar + 1));
		// "100 Fogs Draft - World - Roblox Studio": the experience first, then the place within it
		const label = title.replace(/\s*-\s*Roblox Studio.*$/i, "").replace(/^\*\s*/, "").trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		const [name, ...rest] = label.split(/\s+-\s+/);
		const log = logs.find((l) => Math.abs(l.started - started) <= 3000);
		studios.push({ id: "", name, placeId: log?.placeId ?? "", universeId: log?.universeId, detail: rest.join(" - ") });
	}
	return studios;
}

function stampToMs(s: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s.trim());
	return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

function studioLogs(): { started: number; placeId: string; universeId?: string }[] {
	const dir = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "logs");
	if (!fs.existsSync(dir)) return [];
	const dayAgo = Date.now() - 24 * 3600_000;
	const out: { started: number; placeId: string; universeId?: string }[] = [];
	for (const f of fs.readdirSync(dir)) {
		const m = /_(\d{8}T\d{6})Z_Studio_/i.exec(f);
		if (!m || !f.endsWith(".log")) continue;
		const started = stampToMs(m[1]);
		if (started < dayAgo) continue;
		// one window can load several places in a row (File, Open from Roblox): the LAST ids are the current place
		let text: string;
		try { text = fs.readFileSync(path.join(dir, f), { encoding: "utf8" }); } catch { continue; }   // Studio is writing it
		const last = (re: RegExp) => { let m: RegExpExecArray | null, v: string | undefined; while ((m = re.exec(text))) v = m[1]; return v; };
		const placeId = last(/placeid:\s*(\d{6,})/gi);
		if (placeId) out.push({ started, placeId, universeId: last(/universeid:\s*(\d{6,})/gi) });
	}
	return out;
}

async function listStudiosViaMcp(): Promise<Studio[]> {
	return studioSession(async (call) => {
		const r = await call("tools/call", { name: "list_roblox_studios", arguments: {} });
		if (r?.error) throw new Error(String(r.error.message ?? JSON.stringify(r.error)));
		const text = toolText(r);
		// the server answers {"studios":[{id,name}]} as text; take any array of {id,name} it gives, or scan for pairs
		let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
		let list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.studios) ? parsed.studios : [];
		if (!list.length) list = Array.from(text.matchAll(/"id"\s*:\s*"([^"]+)"\s*,\s*"name"\s*:\s*"([^"]*)"/g), (m) => ({ id: m[1], name: m[2] }));
		if (!list.length && /error|not connected|no studio|failed|unable to reach/i.test(text)) throw new Error(text.slice(0, 160));
		return list.map((s) => {
			const m = /^(.*?)\s*\(placeId:\s*(\d+)\)\s*$/.exec(String(s.name ?? ""));
			return { id: String(s.id), name: m ? m[1] : String(s.name ?? s.id), placeId: m ? m[2] : "" };
		});
	}, 6000);   // a short leash: the windows list runs alongside and carries when this hangs
}

// ---- Studio's Script Sync records ---------------------------------------------------------------------------
// HKCU\Software\Roblox\RobloxStudio holds File_Sync_Persistence_Record_V1:<placeId>:<guid> (a JSON array of the
// synced instances and their files) plus a _lastUsedDir. Whatever paths are in there, their common directory
// is the sync folder.

async function syncFolderFor(placeId: string): Promise<string | undefined> {
	if (process.platform !== "win32" || !placeId) return undefined;
	const record = await syncRecordName(placeId);
	if (!record) return undefined;
	// each entry's filePath is the service's own folder ("C:/Users\\me\\...\\ReplicatedStorage"); the project is its parent
	const parents = (await readSyncRecord(record))
		.map((e) => path.dirname(e.filePath.replace(/\//g, "\\").replace(/\\+/g, "\\")))
		.filter((p) => /^[A-Za-z]:\\.+/.test(p) && fs.existsSync(p));
	if (!parents.length) return undefined;
	const counts = new Map<string, number>();
	for (const p of parents) counts.set(p.toLowerCase(), (counts.get(p.toLowerCase()) ?? 0) + 1);
	const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
	return parents.find((p) => p.toLowerCase() === best);
}

// ---- git ------------------------------------------------------------------------------------------------------

const git = (args: string[], cwd?: string) => new Promise<{ ok: boolean; out: string }>((res) =>
	execFile("git", args, { cwd, windowsHide: true, timeout: 30000 }, (e, out, err) => res({ ok: !e, out: String(out ?? "") + String(err ?? "") })));

async function wireGit(folder: string, name: string): Promise<string> {
	const org = cfg("githubOrg", "Maquoketa-Research");
	const url = `https://github.com/${org}/${slug(name)}.git`;
	if (fs.existsSync(path.join(folder, ".git"))) return `git: already a repo (${folder})`;
	const remote = await git(["ls-remote", "--exit-code", "--heads", url]);
	const empty = fs.readdirSync(folder).length === 0;
	if (remote.ok && empty) {
		const c = await git(["clone", url, folder]);
		return c.ok ? `git: cloned ${url}` : `git: clone failed (${c.out.trim().slice(0, 120)})`;
	}
	await git(["init", "-q"], folder);
	await git(["remote", "add", "origin", url], folder);
	if (!fs.existsSync(path.join(folder, ".gitignore"))) fs.writeFileSync(path.join(folder, ".gitignore"), "assets/meshy/\nsourcemap.json\n");
	return remote.ok ? `git: init, origin ${url} (repo exists, folder was not empty)` : `git: init, origin ${url} (repo not on GitHub yet)`;
}

// ---- the command ----------------------------------------------------------------------------------------------

export async function addStudioProject(ctx: vscode.ExtensionContext) {
	log.appendLine(`--- Add Roblox Studio project (${new Date().toLocaleTimeString()})`);
	let studios: Studio[] = [];
	try {
		studios = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Looking for open Roblox Studio windows…" }, () => listStudios());
	} catch (e) { lastListError = (e as Error).message; log.appendLine(`listStudios threw: ${lastListError}`); }
	if (!studios.length) {
		const pick = await vscode.window.showWarningMessage(`Parlay found no open Roblox Studio window${lastListError ? ` (${lastListError})` : ""}.`, "Type the place name");
		if (!pick) return;
	}
	let chosen: Studio | undefined;
	if (studios.length) {
		const item = await vscode.window.showQuickPick(
			studios.map((s) => ({ label: s.name, description: s.placeId ? `placeId ${s.placeId}` : `${s.detail ? s.detail + " · " : ""}no place id found (right-click path)`, s })),
			{ placeHolder: "Which open Roblox Studio is the project?", ignoreFocusOut: true });
		chosen = item?.s;
		log.appendLine(chosen ? `picked ${chosen.name} placeId=${chosen.placeId || "none"}` : "picker dismissed");
		if (!chosen) return;
	} else {
		const name = await vscode.window.showInputBox({ prompt: "Name of the Roblox place", placeHolder: "100 Fogs" });
		if (!name) return;
		chosen = { id: "", name, placeId: "" };
	}

	// the folder Studio already syncs to, else the one Parlay made for this place before, else a fresh one
	const home = path.join(cfg("projectsDir", "") || path.join(os.homedir(), "Documents", "Parlay"), slug(chosen.name));
	let folder = await syncFolderFor(chosen.placeId);
	// never adopt a folder outside the user's profile (a bad parse must not turn C:\Users into a repo)
	if (folder && !folder.toLowerCase().startsWith(os.homedir().toLowerCase() + path.sep)) folder = undefined;
	const synced = !!folder;
	if (!folder) { folder = home; fs.mkdirSync(folder, { recursive: true }); }
	const gitNote = await wireGit(folder, chosen.name);
	await ctx.globalState.update(`studioProject:${chosen.placeId || slug(chosen.name)}`, { folder, name: chosen.name, placeId: chosen.placeId, added: Date.now() });

	const record = chosen.placeId ? await syncRecordName(chosen.placeId) : undefined;
	// An entry whose own folder is gone is stale (the user deleted the project, or just the service folders, to start
	// over): an open Studio shows it Errored "Unable to read from file" and never recreates it, so rewrite it. The
	// service folder, not its parent: Parlay has just made the parent, so the parent proves nothing.
	const existing = (record ? await readSyncRecord(record) : []).filter((e) => fs.existsSync(e.filePath.replace(/\//g, "\\").replace(/\\+/g, "\\")));
	const missing = SCRIPT_CONTAINERS.filter((c) => !existing.some((e) => e.className === c));
	log.appendLine(`folder ${folder} (${synced ? "already syncing" : "new"}); record ${record ?? "none"}; ${existing.length} live entries; missing ${missing.join(", ") || "nothing"}`);
	if (chosen.placeId && missing.length) {
		// The zero-click path. Studio keeps a per-place record of what it syncs and resumes it when the place
		// opens; it accepts entries we write (any id, the service by class name) but only in the slot it named
		// itself, and it (re)writes that slot when the place closes. So: the user closes the place, Parlay writes
		// into the slot (which now exists even for a brand-new place), Parlay reopens the place through Studio's
		// own link, Studio writes every script into the folder. Entries Studio already has stay.
		const go = await vscode.window.showInformationMessage(
			`Parlay will set Studio up to sync ${missing.join(", ")} of "${chosen.name}" into ${folder} (${gitNote}). Close that place in Studio when you are ready; Parlay finishes the moment it closes and reopens the place syncing.`,
			{ modal: true }, "I'll close it now");
		if (!go) return;
		const closed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Waiting for "${chosen.name}" to close in Studio…`, cancellable: true },
			(_p, token) => waitForPlaceClose(chosen!.name, token));
		if (!closed) return;
		await new Promise((r) => setTimeout(r, 1500));   // Studio finishes writing its record just after the window goes
		const slot = record ?? await syncRecordName(chosen.placeId);
		if (!slot) { void vscode.window.showWarningMessage(`Studio left no sync record for "${chosen.name}"; open it and use Sync to… once, then run this again.`); return; }
		const universe = chosen.universeId ?? await universeIdFor(chosen.placeId).catch(() => undefined);
		// the Starter containers only resume with their real ids: a place file on this machine or Open Cloud has them
		const real = await starterIds(ctx, chosen, slot, universe).catch(() => new Map<string, string>());
		const keep = record ? existing : await readSyncRecord(slot);
		const starters = Array.from(real.keys()).filter((c) => !keep.some((e) => e.className === c));
		await writeSyncRecord(slot, folder, keep, missing, starters, real);
		log.appendLine(`wrote ${slot}: kept ${keep.length}, added ${[...missing, ...starters].join(", ")}; universe ${universe ?? "unknown"}`);
		if (universe) openStudio(`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${chosen.placeId}+universeId:${universe}`);
		const head = universe
			? `Studio is reopening "${chosen.name}" and syncing it into ${folder}. Scripts appear as they land.`
			: `Sync is set up for "${chosen.name}". Reopen the place in Studio and it syncs into ${folder}.`;
		if (starters.length) { void vscode.window.showInformationMessage(`${head} Also syncing ${starters.join(", ")}.`); }
		else {
			// the Starter containers need their real ids, which only a place file or Open Cloud can give; offer the key here
			void vscode.window.showInformationMessage(`${head} ${MANUAL_CONTAINERS} need an Open Cloud API key (or a saved place file) to sync automatically; with the key set, run Add Roblox Studio Project once more and they join. Until then, right-click them in Studio, Sync to…, same folder.`, "Set Open Cloud key")
				.then((pick) => { if (pick) void vscode.commands.executeCommand("parlay.roblox.setKey"); });
		}
	} else if (!synced) {
		{
			await vscode.env.clipboard.writeText(folder);
			const selected = chosen.id ? await selectScriptContainers(chosen.id).catch(() => false) : false;
			const how = await vscode.window.showInformationMessage(
				`"${chosen.name}" is not syncing yet. Parlay made ${folder} (path on your clipboard; ${gitNote}). `
				+ (selected ? "The script containers are selected in Studio's Explorer: right-click them, Sync to…, paste the path, Save."
					: "In Studio's Explorer select ServerScriptService, ReplicatedStorage and StarterPlayer, right-click, Sync to…, paste the path, Save.")
				+ " Scripts appear here as they sync, and Studio resumes the sync every time the place opens.",
				{ modal: true }, "Open the folder", "How Script Sync works");
			if (how === "How Script Sync works") void vscode.env.openExternal(vscode.Uri.parse("https://create.roblox.com/docs/scripting/sync"));
		}
	} else {
		void vscode.window.showInformationMessage(`"${chosen.name}" already syncs into ${folder}; opening it.`);
	}
	await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), { forceNewWindow: false });
}

// Studio's own link, started from the home folder: a window opened with openExternal inherits Parlay's working
// directory (the app folder) and holds it until it closes, which then blocks reinstalling Parlay with EBUSY.
function openStudio(url: string) {
	spawn("cmd.exe", ["/d", "/c", "start", "", url], { cwd: os.homedir(), detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// ---- writing Studio's sync record ---------------------------------------------------------------------------
// Verified 2026-09-15 on Studio's File_Sync_Persistence_Record_V1: an entry needs className, filePath, scriptId
// and status; Studio resolves a service by className and does not check the id (a made-up one synced all of
// ReplicatedStorage), but it skips entries without one.

// The containers Studio resolves by class name when it resumes from a record we wrote. StarterPlayer, StarterGui,
// StarterPlayerScripts and StarterCharacterScripts all came back "the instance no longer exists" (tested
// 2026-09-15), so those two stay a right-click in Studio when they hold scripts.
const SCRIPT_CONTAINERS = ["ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage"];
const MANUAL_CONTAINERS = "StarterPlayer and StarterGui";
const STUDIO_KEY = "HKCU:\\Software\\Roblox\\RobloxStudio";

function powershell(script: string): Promise<string> {
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return new Promise((res) => execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], { windowsHide: true, maxBuffer: 8 << 20 }, (_e, out) => res(String(out ?? ""))));
}

// the record Studio made for this place (it makes one when the place opens); undefined when it never has
async function syncRecordName(placeId: string): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	const out = await powershell(`(Get-Item '${STUDIO_KEY}').GetValueNames() | Where-Object { $_ -like 'File_Sync_Persistence_Record_V1:${placeId}:*' -and $_ -notlike '*_timeLastUsed' -and $_ -notlike '*_lastUsedDir' }`);
	return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
}

interface SyncEntry { className: string; filePath: string; scriptId?: string; status: string }

async function readSyncRecord(record: string): Promise<SyncEntry[]> {
	const out = await powershell(`(Get-ItemProperty '${STUDIO_KEY}').'${record}'`);
	// entries without a scriptId are ones Studio ignores; treat them as absent so they get rewritten with one
	try { const v = JSON.parse(out); return Array.isArray(v) ? v.filter((e) => e && e.className && e.filePath && e.scriptId) : []; } catch { return []; }
}

async function writeSyncRecord(record: string, folder: string, keep: SyncEntry[], services: string[], starters: string[] = [], realIds = new Map<string, string>()) {
	// Studio writes paths as "C:/Users\\name\\..." (forward slash after the drive, backslashes after); mimic it
	const studioPath = (p: string) => p.replace(/\//g, "\\").replace(/^([A-Za-z]:)\\/, "$1/");
	const entry = (className: string, scriptId: string): SyncEntry => ({ className, filePath: studioPath(path.join(folder, className)), scriptId, status: "Syncing" });
	const entries: SyncEntry[] = [...keep, ...services.map((c) => entry(c, randomUUID())), ...starters.map((c) => entry(c, realIds.get(c)!))];
	// Studio must create the service folders itself: an existing but empty folder reads as "previously synced
	// content" and the resume ends "Errored / Unable to read from file" (every failure tonight had pre-made folders)
	for (const s of [...services, ...starters]) {
		const p = path.join(folder, s);
		if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
	}
	const b64 = Buffer.from(JSON.stringify(entries, null, 4), "utf8").toString("base64");
	await powershell(`$k = '${STUDIO_KEY}'; $n = '${record}'
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
Set-ItemProperty -Path $k -Name $n -Value $json -Type String
Set-ItemProperty -Path $k -Name ($n + '_lastUsedDir') -Value '${folder.replace(/\\/g, "/")}' -Type String
Set-ItemProperty -Path $k -Name ($n + '_timeLastUsed') -Value ([int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) -Type QWord`);
}

// ---- real ids for the Starter containers ---------------------------------------------------------------------
// Studio resumes StarterPlayerScripts, StarterCharacterScripts and StarterGui only by their real UniqueIds, which
// plugins cannot read. Three places have them: the place file itself when the window is a local .rbxl, Studio's
// Auto-Recovery file for the place (matched by the Workspace id, which is also the record slot's guid), and the
// Open Cloud Instances API when a key with the universe-place-instances scope is stored.

const STARTERS = ["StarterPlayerScripts", "StarterCharacterScripts", "StarterGui"];

async function starterIds(ctx: vscode.ExtensionContext, studio: Studio, slot: string, universe?: string): Promise<Map<string, string>> {
	const slotGuid = slot.split(":")[2]?.toLowerCase();
	const fromFile = (file: string) => {
		const ids = readPlaceIds(file);
		const out = new Map<string, string>();
		for (const c of STARTERS) { const id = ids.byClass.get(c)?.[0]; if (id) out.set(c, id); }
		return { out, workspace: ids.workspace?.toLowerCase() };
	};
	// a local place: the window title is the file
	if (/\.rbxlx?$/i.test(studio.name) && fs.existsSync(studio.name)) { const r = fromFile(studio.name); if (r.out.size) return r.out; }
	// Studio's Auto-Recovery copies, newest first, the one whose Workspace is this place's slot guid
	const dir = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "RobloxStudio", "AutoSaves");
	if (fs.existsSync(dir) && slotGuid) {
		const files = fs.readdirSync(dir).filter((f) => /_AutoRecovery_\d+\.rbxlx?$/i.test(f)).map((f) => path.join(dir, f))
			.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 12);
		for (const { f } of files) {
			try { const r = fromFile(f); if (r.workspace === slotGuid && r.out.size) return r.out; } catch { /* not a place file we can read */ }
		}
	}
	// Open Cloud, as the signed-in Roblox account or with a stored key
	const auth = await cloudAuth(ctx);
	if (auth.length && universe && studio.placeId) return openCloudStarterIds(auth, universe, studio.placeId);
	return new Map();
}

// Open Cloud credentials in the order to try them: the signed-in Roblox account (OAuth bearer), then the stored API
// key. The Instance resource lists API Key (and HttpService) only, no OAuth 2.0, as of 2026-09-15
// (https://create.roblox.com/docs/cloud/reference/Instance), so today the bearer comes back 401 and the key carries;
// the retry in openCloudStarterIds makes the switch automatic the day Roblox adds an instance scope.
export async function cloudAuth(ctx: vscode.ExtensionContext): Promise<Record<string, string>[]> {
	const out: Record<string, string>[] = [];
	const s = await vscode.authentication.getSession("roblox", ROBLOX_SCOPES, { silent: true }).then((x) => x, () => undefined);
	if (s) out.push({ Authorization: `Bearer ${s.accessToken}` });
	const key = await ctx.secrets.get("parlay.robloxApiKey");
	if (key) out.push({ "x-api-key": key });
	return out;
}

async function openCloudStarterIds(auth: Record<string, string>[], universe: string, place: string): Promise<Map<string, string>> {
	const base = `https://apis.roblox.com/cloud/v2`;
	let a = 0;   // the credential that worked last; 401/403 moves on to the next, anything else is the answer
	const call = async (p: string, init: RequestInit = {}): Promise<any> => {
		for (; a < auth.length; a++) {
			const r = await fetch(`${base}/${p}`, { ...init, headers: { ...auth[a], "Content-Type": "application/json" } });
			if ((r.status === 401 || r.status === 403) && a + 1 < auth.length) continue;
			if (!r.ok) throw new Error(`Open Cloud ${r.status}`);
			return r.json();
		}
		throw new Error("Open Cloud: no credential");
	};
	const children = async (instanceId: string): Promise<{ Id: string; Name: string; Details: Record<string, unknown> }[]> => {
		let j = (await call(`universes/${universe}/places/${place}/instances/${instanceId}:listChildren`, { method: "POST", body: "{}" })) as { path?: string; done?: boolean; response?: { instances?: { engineInstance: { Id: string; Name: string; Details: Record<string, unknown> } }[] } };
		for (let i = 0; i < 20 && !j.done && j.path; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			j = (await call(j.path)) as typeof j;
		}
		return (j.response?.instances ?? []).map((i) => i.engineInstance);
	};
	const out = new Map<string, string>();
	const root = await children("root");
	const cls = (e: { Details: Record<string, unknown> }) => Object.keys(e.Details ?? {})[0] ?? "";
	const gui = root.find((e) => cls(e) === "StarterGui" || e.Name === "StarterGui"); if (gui) out.set("StarterGui", gui.Id);
	const sp = root.find((e) => cls(e) === "StarterPlayer" || e.Name === "StarterPlayer");
	if (sp) for (const c of await children(sp.Id)) { const k = cls(c) || c.Name; if (STARTERS.includes(k)) out.set(k, c.Id); }
	return out;
}

// true when no Studio window carries the place name any more (polled), false on cancel or after ten minutes
async function waitForPlaceClose(name: string, token: vscode.CancellationToken): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < 10 * 60_000 && !token.isCancellationRequested) {
		const open = await listStudiosViaWindows();
		if (!open.some((s) => s.name.toLowerCase() === name.toLowerCase())) return true;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

// Studio's edit link needs the universe (experience) id as well as the place id; Roblox answers this publicly
async function universeIdFor(placeId: string): Promise<string | undefined> {
	const r = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
	if (!r.ok) return undefined;
	const j = (await r.json()) as { universeId?: number | string | null };
	return j.universeId !== undefined && j.universeId !== null ? String(j.universeId) : undefined;
}

// Studio's Explorer selection, set through the MCP server's Luau runner (Edit DataModel). True when it worked.
async function selectScriptContainers(studioId: string): Promise<boolean> {
	const code = "local s = game:GetService('Selection'); local t = {}; for _, n in ipairs({'ServerScriptService','ReplicatedStorage','StarterPlayer','ServerStorage','StarterGui'}) do local ok, svc = pcall(game.GetService, game, n); if ok and svc then table.insert(t, svc) end end; s:Set(t); return #t";
	return studioSession(async (call) => {
		const r = await call("tools/call", { name: "execute_luau", arguments: { studio_id: studioId, datamodel_type: "Edit", code } });
		return !r?.error && !r?.result?.isError;
	}, 15000);
}
