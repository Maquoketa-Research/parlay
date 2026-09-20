// Parlay pairs directly with Aqua; dashboard approval grants this client its own credential.
import * as vscode from "vscode";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { log } from "./log";
import { SCOPES } from "./roblox-auth";
import { chooseProjectIdentity, ProjectIdentity, robloxId } from "./aquaIdentity";
import { readMacPreferences, macRecordNames, macEntries } from "./macStudioSync";
import { listStudios, studioIdentity } from "./studio";
import { checkPairing, pairingSecret, requestPairing, PairedPlace } from "./aquaPairing";

const cfg = () => vscode.workspace.getConfiguration("parlay");
// the hosted Aqua by default; a localhost URL means a checkout Parlay can start (startAqua)
export const aquaUrl = () => cfg().get<string>("aquaUrl", "https://aqua.maquoketa.net").replace(/\/+$/, "");
export const aquaIsLocal = () => { try { return ["localhost", "127.0.0.1"].includes(new URL(aquaUrl()).hostname); } catch { return false; } };

// ---- the server ---------------------------------------------------------------------------------

export function reachable(url: string): Promise<boolean> {
	return new Promise((res) => {
		try {
			const req = (url.startsWith("https") ? https : http).get(url, (r) => { r.resume(); res(true); });
			req.setTimeout(1500, () => { req.destroy(); res(false); });
			req.on("error", () => res(false));
		} catch { res(false); }
	});
}

// Where the aqua checkout is: the setting, else a sibling of the workspace named aqua, else ~/Documents/GitHub/aqua.
function aquaRepo(): string | undefined {
	const set = cfg().get<string>("aquaRepo", "");
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const guesses = [set, ws ? path.join(path.dirname(ws), "aqua") : "", path.join(os.homedir(), "Documents", "GitHub", "aqua")];
	return guesses.find((g) => g && fs.existsSync(path.join(g, "pyproject.toml")));
}

export function startAqua(): boolean {
	const repo = aquaRepo();
	if (!repo) {
		void vscode.window.showWarningMessage("Parlay: aqua checkout not found. Set parlay.aquaRepo to its folder.", "Open Settings")
			.then((p) => { if (p) void vscode.commands.executeCommand("workbench.action.openSettings", "parlay.aquaRepo"); });
		return false;
	}
	const t = vscode.window.terminals.find((x) => x.name === "Aqua") ?? vscode.window.createTerminal({ name: "Aqua", cwd: repo });
	t.show(true);
	t.sendText("uv run aqua serve --worker", true);
	return true;
}

// Aqua's JSON API the way its own api.js calls it: {ok, status, data}; a network failure is ok:false, status 0.
// A 401 from a hosted Aqua is retried once after a silent session trade (below).
export interface Reply { ok: boolean; status: number; data: any }
export async function api(method: string, route: string, body?: unknown): Promise<Reply> {
	const r = await call(method, route, body);
	if (r.status !== 401 || aquaIsLocal()) return r;
	if (await aquaSignIn(true)) return call(method, route, body);
	return r;
}
async function call(method: string, route: string, body?: unknown): Promise<Reply> {
	try {
		const r = await fetch(aquaUrl() + route, {
			method, body: body === undefined ? undefined : JSON.stringify(body),
			headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(await sessionHeaders()) },
			signal: AbortSignal.timeout(8000),
		});
		return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
	} catch (e) { return { ok: false, status: 0, data: { detail: (e as Error).message } }; }
}
export const detail = (r: Reply) => String(r.data?.detail ?? `HTTP ${r.status}`);

// ---- the session on a hosted Aqua ---------------------------------------------------------------

// docs/aqua.md proposal A: POST /api/auth/token {access_token} with Parlay's Roblox OAuth access token answers
// {session}, the same value the browser gets as Set-Cookie; it goes back as the aqua_session cookie.
const SESSION_KEY = "parlay.aquaSession";
let secrets: vscode.SecretStorage | undefined;
let lastTrade = 0;   // a failed trade is not repeated on every call: once per five minutes until Aqua has the route
export async function sessionHeaders(): Promise<Record<string, string>> {
	const s = aquaIsLocal() ? undefined : await secrets?.get(SESSION_KEY);
	return s ? { Cookie: `aqua_session=${s}` } : {};
}
// Trade the Roblox session for an Aqua one. `silent` never prompts (a call retrying a 401); the command prompts
// for the Roblox sign-in when there is none. True when Aqua handed a session back.
export async function aquaSignIn(silent: boolean): Promise<boolean> {
	if (silent && Date.now() - lastTrade < 5 * 60_000) return false;
	lastTrade = Date.now();
	const s = await vscode.authentication.getSession("roblox", SCOPES, silent ? { silent: true } : { createIfNone: true }).then((x) => x, () => undefined);
	if (!s) return false;
	await secrets?.delete(SESSION_KEY);   // whatever we held came back 401
	const r = await call("POST", "/api/auth/token", { access_token: s.accessToken });
	if (!r.ok || typeof r.data?.session !== "string") { log.info(`Aqua token trade: ${r.status === 404 || r.status === 405 ? "POST /api/auth/token is not on this Aqua yet" : detail(r)}`); return false; }
	await secrets?.store(SESSION_KEY, r.data.session);
	lastTrade = 0;
	return true;
}

// ---- what Aqua knows ----------------------------------------------------------------------------

// GET /api/games. A game's place_id is the place its code is synced from, set the moment a pairing is approved,
// and places[] every place the game knows; a Studio place is paired when one of those is it.
export interface Game { slug: string; name: string; place_id: string; universe_id: string; places?: { place_id: string; name?: string }[] }
export function gameForPlace(list: Game[], placeId: string): Game | undefined {
	if (!placeId) return undefined;
	return list.find((g) => g.place_id === placeId || (g.places ?? []).some((p) => p.place_id === placeId));
}
// Credentials are scoped to the server, place and Roblox account; project selection is workspace-local.
let context: vscode.ExtensionContext;
let active: { controller: AbortController; text: string } | undefined;
const metadataKey = (url: string) => `aquaPairedPlace:${url}`;
export interface Strip { text: string; action?: { label: string; command: string }; paired?: boolean }
const PAIR = { label: "Pair with Aqua", command: "parlay.aqua.pair" };
export async function aquaStrip(): Promise<Strip> {
	if (active) return { text: active.text, action: { label: "Cancel", command: "parlay.aqua.cancelPair" }, paired: false };
	const url = aquaUrl();
	const place = context?.workspaceState.get<PairedPlace>(metadataKey(url));
	const key = place && await secrets?.get(pairingSecret(url, place));
	if (!place || !key) return { text: "Pair this project with Aqua directly from Parlay.", action: PAIR, paired: false };
	try {
		await checkPairing(url, place, key, AbortSignal.timeout(8000));
		return { text: `${place.placeName}: paired with ${place.game}`, paired: true };
	} catch { return { text: `Could not verify the pairing for ${place.placeName}. Check Aqua or pair again.`, action: PAIR, paired: false }; }
}

async function pairProject(refresh: () => void, showDashboard: () => void) {
	if (active) return;
	if (!vscode.workspace.workspaceFolders?.length) {
		const open = await vscode.window.showInformationMessage("Open your game project before pairing with Aqua.", "Open Project");
		if (open) await vscode.commands.executeCommand("workbench.action.files.openFolder");
		return;
	}
	const url = aquaUrl();
	const controller = new AbortController();
	active = { controller, text: "Preparing to pair with Aqua…" };
	try {
		const previous = context.workspaceState.get<PairedPlace>(metadataKey(url));
		const root = vscode.workspace.workspaceFolders![0];
		const sameFolder = (folder: string) => process.platform === "win32" ? path.resolve(folder).toLowerCase() === path.resolve(root.uri.fsPath).toLowerCase() : path.resolve(folder) === path.resolve(root.uri.fsPath);
		const mapped: ProjectIdentity[] = [];
		for (const key of context.globalState.keys()) {
			if (!key.startsWith("studioProject:")) continue;
			const project = context.globalState.get<ProjectIdentity & { folder: string }>(key);
			if (project?.folder && sameFolder(project.folder)) mapped.push(project);
		}
		// Native Script Sync is authoritative when its paths identify this workspace.
		const native: ProjectIdentity[] = [];
		if (process.platform === "darwin") {
			const prefs: Record<string, unknown> = await readMacPreferences().catch(() => ({}));
			for (const record of macRecordNames(prefs)) {
				try {
					if (macEntries(prefs[record]).some(entry => sameFolder(path.dirname(entry.filePath)))) native.push({ placeId: record.split(":")[1], name: root.name });
				} catch { /* skip malformed records */ }
			}
		}
		let identity = chooseProjectIdentity(native.length ? native : mapped, { placeId: context.workspaceState.get<string>("aquaPlaceId") ?? previous?.placeId, universeId: previous?.universeId, name: previous?.placeName });
		if (identity && !identity.universeId) identity = { ...identity, universeId: mapped.find(p => p.placeId === identity!.placeId)?.universeId };
		const studios = await listStudios().catch(() => []);
		let detected = identity ? studios.find(s => s.placeId === identity!.placeId) : undefined;
		if (!identity) {
			const available = studios.filter(s => robloxId(s.placeId) || s.id);
			const choice = await vscode.window.showQuickPick(available.map(studio => ({ label: studio.name, studio })), { title: "Pair with Aqua", placeHolder: "Which Studio place belongs to this project?" });
			if (!choice) {
				if (!available.length) void vscode.window.showInformationMessage("Connect this project's Script Sync first, or enable Studio MCP so Parlay can read its place identity.");
				return;
			}
			detected = choice.studio;
			identity = detected;
		}
		const live = detected ? await studioIdentity(detected).catch(() => undefined) : undefined;
		if (live && (!identity.placeId || identity.placeId === live.placeId)) identity = { ...identity, ...live };
		const placeId = robloxId(identity.placeId);
		if (!placeId || controller.signal.aborted) {
			if (!controller.signal.aborted) void vscode.window.showInformationMessage("Studio has not exposed a published place ID yet. Open the published place and try again.");
			return;
		}
		let session = await vscode.authentication.getSession("roblox", SCOPES, { silent: true }).then(s => s, () => undefined);
		let studioUserId = robloxId(identity.studioUserId) ?? robloxId(session?.account.id) ?? robloxId(previous?.studioUserId);
		if (!studioUserId) {
			session = await vscode.authentication.getSession("roblox", SCOPES, { createIfNone: true });
			studioUserId = robloxId(session?.account.id);
		}
		if (!studioUserId || controller.signal.aborted) return;
		const place = { placeId, studioUserId, universeId: identity.universeId ?? "", placeName: identity.name ?? root.name };
		// Remember the resolved project association even if dashboard approval is cancelled.
		await context.workspaceState.update("aquaPlaceId", placeId);

		showDashboard();
		await vscode.commands.executeCommand("parlay.aqua.focus");
		const ready = await vscode.window.showInformationMessage("Sign in to Aqua in the panel and keep the dashboard open, then request pairing.", "Request Pairing");
		if (!ready || controller.signal.aborted) return;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Pair with Aqua", cancellable: true }, async (progress, token) => {
			const cancel = token.onCancellationRequested(() => controller.abort());
			try {
				const result = await requestPairing(url, place, controller.signal, code => {
					active!.text = `Pairing code: ${code} — approve the matching code in Aqua.`;
					progress.report({ message: active!.text });
					refresh();
				});
				controller.signal.throwIfAborted();
				await context.secrets.store(pairingSecret(url, place), result.key);
				await context.workspaceState.update(metadataKey(url), { ...place, game: result.game });
				await context.workspaceState.update("aquaPlaceId", place.placeId);
				void vscode.window.showInformationMessage(`Parlay is paired with ${result.game}.`);
			} finally { cancel.dispose(); }
		});
	} catch (e) {
		if (!controller.signal.aborted) void vscode.window.showWarningMessage(`Aqua pairing: ${(e as Error).name === "TimeoutError" ? "The request timed out. Pair again." : (e as Error).message}`);
	} finally { active = undefined; refresh(); }
}

export function registerAqua(ctx: vscode.ExtensionContext, refresh: () => void, showDashboard: () => void) {
	context = ctx;
	secrets = ctx.secrets;
	ctx.subscriptions.push(
		vscode.commands.registerCommand("parlay.aqua.pair", () => pairProject(refresh, showDashboard)),
		vscode.commands.registerCommand("parlay.aqua.cancelPair", () => active?.controller.abort()),
		{ dispose: () => active?.controller.abort() },
	);
}
