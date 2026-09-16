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

export interface Studio { id: string; name: string; placeId: string; detail?: string; universeId?: string }

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
		const done = (err?: Error, value?: T) => { clearTimeout(t); child.kill(); err ? reject(err) : resolve(value as T); };
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
export async function listStudios(): Promise<Studio[]> {
	// the MCP server is the source of truth (instance id and place id straight from Studio); the windows and
	// their logs are the backup, and fill in any window the server did not report
	let studios: Studio[] = [];
	try { studios = await listStudiosViaMcp(); } catch { /* seat taken or server down */ }
	const viaWindows = await listStudiosViaWindows().catch(() => [] as Studio[]);
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
	const logs = studioLogs();
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
		const head = fs.readFileSync(path.join(dir, f), { encoding: "utf8" }).slice(0, 400_000);
		const placeId = /placeid:\s*(\d{6,})/i.exec(head)?.[1];
		if (placeId) out.push({ started, placeId, universeId: /universeid:\s*(\d{6,})/i.exec(head)?.[1] });
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
		if (!list.length && /error|not connected|no studio|failed/i.test(text)) throw new Error(text.slice(0, 160));
		return list.map((s) => {
			const m = /^(.*?)\s*\(placeId:\s*(\d+)\)\s*$/.exec(String(s.name ?? ""));
			return { id: String(s.id), name: m ? m[1] : String(s.name ?? s.id), placeId: m ? m[2] : "" };
		});
	});
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
	let studios: Studio[] = [];
	try { studios = await listStudios(); }
	catch (e) {
		const pick = await vscode.window.showWarningMessage(`Parlay could not ask Studio which places are open (${(e as Error).message}).`, "Type the place name");
		if (!pick) return;
	}
	let chosen: Studio | undefined;
	if (studios.length) {
		const item = await vscode.window.showQuickPick(
			studios.map((s) => ({ label: s.name, description: s.placeId ? `placeId ${s.placeId}` : (s.detail ?? ""), s })),
			{ placeHolder: "Which open Roblox Studio is the project?" });
		chosen = item?.s;
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
	const existing = record ? await readSyncRecord(record) : [];
	const missing = SCRIPT_CONTAINERS.filter((c) => !existing.some((e) => e.className === c));
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
		await writeSyncRecord(slot, folder, record ? existing : await readSyncRecord(slot), missing);
		const universe = chosen.universeId ?? await universeIdFor(chosen.placeId).catch(() => undefined);
		if (universe) await vscode.env.openExternal(vscode.Uri.parse(`roblox-studio:1+launchmode:edit+task:EditPlace+placeId:${chosen.placeId}+universeId:${universe}`));
		void vscode.window.showInformationMessage(universe
			? `Studio is reopening "${chosen.name}" and syncing it into ${folder}. Scripts appear as they land.`
			: `Sync is set up for "${chosen.name}". Reopen the place in Studio and it syncs into ${folder}.`);
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
		void vscode.window.showInformationMessage(`Parlay: "${chosen.name}" syncs to ${folder}. ${gitNote}.`);
	}
	await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), { forceNewWindow: false });
}

// ---- writing Studio's sync record ---------------------------------------------------------------------------
// Verified 2026-09-15 on Studio's File_Sync_Persistence_Record_V1: an entry needs className, filePath, scriptId
// and status; Studio resolves a service by className and does not check the id (a made-up one synced all of
// ReplicatedStorage), but it skips entries without one.

const SCRIPT_CONTAINERS = ["ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterPlayer", "StarterGui"];
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

async function writeSyncRecord(record: string, folder: string, keep: SyncEntry[], services: string[]) {
	// Studio writes paths as "C:/Users\\name\\..." (forward slash after the drive, backslashes after); mimic it
	const studioPath = (p: string) => p.replace(/\//g, "\\").replace(/^([A-Za-z]:)\\/, "$1/");
	const entries: SyncEntry[] = [...keep, ...services.map((className) => ({ className, filePath: studioPath(path.join(folder, className)), scriptId: randomUUID(), status: "Syncing" }))];
	const b64 = Buffer.from(JSON.stringify(entries, null, 4), "utf8").toString("base64");
	await powershell(`$k = '${STUDIO_KEY}'; $n = '${record}'
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
Set-ItemProperty -Path $k -Name $n -Value $json -Type String
Set-ItemProperty -Path $k -Name ($n + '_lastUsedDir') -Value '${folder.replace(/\\/g, "/")}' -Type String
Set-ItemProperty -Path $k -Name ($n + '_timeLastUsed') -Value ([int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) -Type QWord`);
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
