import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { parseMacStudioProcesses } from "./studioDiscovery";

export const STUDIO_DOMAIN = "com.roblox.RobloxStudio";
export interface MacSyncEntry { className: string; filePath: string; scriptId: string; status: string; [key: string]: unknown }
export type Preferences = Record<string, unknown>;
export const native = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) =>
	execFile(file, args, { timeout: 8000, maxBuffer: 8 << 20 }, (error, stdout) => error ? reject(error) : resolve(stdout)));

export async function readMacPreferences(domain = STUDIO_DOMAIN): Promise<Preferences> {
	const script = `ObjC.import("Foundation"); var name=${JSON.stringify(domain)}; var d=$.NSUserDefaults.alloc.initWithSuiteName(name); JSON.stringify(ObjC.deepUnwrap(d.persistentDomainForName(name)) || {});`;
	return JSON.parse(await native("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]));
}
export function macRecordNames(prefs: Preferences, placeId?: string): string[] {
	return Object.keys(prefs).filter(key => /^File_Sync_Persistence_Record_V1:\d+:[\da-f-]+$/i.test(key) && (!placeId || key.split(":")[1] === placeId))
		.sort((a, b) => Number(prefs[b + "_timeLastUsed"] ?? 0) - Number(prefs[a + "_timeLastUsed"] ?? 0));
}
export function macEntries(value: unknown): MacSyncEntry[] {
	if (typeof value !== "string") throw new Error("Studio's sync record is missing or invalid. Open the place in Studio once first.");
	const entries: unknown = JSON.parse(value);
	if (!Array.isArray(entries) || entries.some(e => !e || typeof e.className !== "string" || typeof e.filePath !== "string" || typeof e.scriptId !== "string")) throw new Error("Studio's sync record is invalid; it was left unchanged.");
	return entries;
}
export async function macStudioRunning(): Promise<boolean> {
	return parseMacStudioProcesses(await native("/bin/ps", ["-axo", "pid=,comm="])).length > 0;
}

// Keep every existing entry, including unknown fields and mappings to other folders.
export function mergeMacEntries(existing: MacSyncEntry[], folder: string, ids: Map<string, string>): MacSyncEntry[] {
	const added = [...ids].filter(([name]) => !existing.some(e => e.className === name)).map(([className, scriptId]) => ({ className, scriptId, filePath: path.join(folder, className), status: "Syncing" }));
	return [...existing, ...added];
}

// Write only these three keys through CFPreferences (defaults), never overwrite the plist
// behind cfprefsd. The caller waits for Studio to quit; recheck immediately before writing.
export async function writeMacSync(record: string, folder: string, ids: Map<string, string>, backupDir: string,
	io = { read: readMacPreferences, run: native, running: macStudioRunning }) {
	if (await io.running()) throw new Error("Quit Roblox Studio (⌘Q) before configuring Script Sync.");
	const prefs = await io.read();
	if (!macRecordNames(prefs).includes(record)) throw new Error("The selected Studio sync record no longer exists. Open the place and try again.");
	const entries = mergeMacEntries(macEntries(prefs[record]), folder, ids);
	const keys = [record, record + "_lastUsedDir", record + "_timeLastUsed"];
	const before = Object.fromEntries(keys.map(key => [key, prefs[key] ?? null]));
	fs.mkdirSync(backupDir, { recursive: true });
	const backup = path.join(backupDir, `studio-sync-${Date.now()}-${randomUUID()}.json`);
	fs.writeFileSync(backup, JSON.stringify({ domain: STUDIO_DOMAIN, before }, null, 2), { mode: 0o600 });
	if (await io.running()) throw new Error("Studio reopened before configuration; no preferences were changed.");
	const values = [JSON.stringify(entries, null, 4), folder, Date.now()];
	const removed: string[] = [];
	try {
		// Studio exports into absent directories. Empty pre-created service directories
		// are interpreted as a previous sync and can fail to resume.
		const old = macEntries(prefs[record]);
		for (const entry of entries) {
			if (old.some(e => e.className === entry.className)) continue;
			if (fs.existsSync(entry.filePath) && fs.lstatSync(entry.filePath).isDirectory() && fs.readdirSync(entry.filePath).length === 0) {
				fs.rmdirSync(entry.filePath); removed.push(entry.filePath);
			}
		}
		for (let i = 0; i < keys.length; i++) await io.run("/usr/bin/defaults", ["write", STUDIO_DOMAIN, keys[i], typeof values[i] === "number" ? "-int" : "-string", String(values[i])]);
		const after = await io.read();
		if (keys.some((key, i) => after[key] !== values[i])) throw new Error("Studio preferences did not retain the sync settings.");
	} catch (error) {
		// Never restore into a running Studio which may already be writing newer state.
		if (await io.running()) throw new Error(`Configuration failed and Studio reopened. Backup: ${backup}. ${(error as Error).message}`);
		try {
			for (const dir of removed) fs.mkdirSync(dir, { recursive: true });
			for (const key of keys) {
				const value = before[key];
				if (value === null) {
					if ((await io.read())[key] !== undefined) await io.run("/usr/bin/defaults", ["delete", STUDIO_DOMAIN, key]);
				} else await io.run("/usr/bin/defaults", ["write", STUDIO_DOMAIN, key, typeof value === "number" ? "-int" : "-string", String(value)]);
			}
		} catch { throw new Error(`Could not restore the previous sync preferences. Backup: ${backup}`); }
		throw error;
	}
	return { entries, backup };
}
