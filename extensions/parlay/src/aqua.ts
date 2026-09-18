// Aqua from inside Parlay: whether the server is up, whether the Studio plugin is installed, whether the open
// place is paired, and the pairing handshake itself, driven from here so the browser dashboard never has to be
// opened. docs/aqua.md has the protocol as Aqua implements it and what is proposed on its side; the issues
// list and evidence panel over the same API live in aquaIssues.ts.
//
// Aqua's pairing: the plugin in Studio has no key, so it POSTs /api/studio/pair with the place it has open and
// gets a six-letter code, then long-polls GET /api/studio/pair/<id>. A dashboard user sees the request at
// GET /api/pairing and approves it (POST /api/pairing/<id>/approve), which hands the plugin the game key over
// its own poll; the plugin stores it per place (plugin setting aqua_key:<placeId>). Nothing but the plugin can
// store that key, so the one click that stays in Studio is "Pair this place with Aqua"; everything around it
// (server up, plugin installed, spotting the request, showing the code, approving) happens here.
//
// Dashboard calls: Aqua without Roblox sign-in (no AQUA_ROBLOX_CLIENT_ID, which is the local setup) answers
// every caller as the local operator. The hosted Aqua wants its aqua_session cookie; Parlay gets one by trading
// the Roblox access token it already holds (docs/aqua.md, proposal A) and keeps it in SecretStorage. Until Aqua
// ships that endpoint the trade answers 404 and dashboard calls stay 401, which the panel explains.
import * as vscode from "vscode";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { log } from "./log";
import { SCOPES } from "./roblox-auth";
import { listStudios, listStudiosViaWindows, Studio } from "./studio";

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
// GET /api/pairing: what the plugin asked for, matched by Aqua to a game of the user's on the universe.
interface PairRequest { id: string; code: string; place_id: string; place_name: string; universe_id: string; matched_game: { slug: string; name: string } | null }

export function gameForPlace(list: Game[], placeId: string): Game | undefined {
	if (!placeId) return undefined;
	return list.find((g) => g.place_id === placeId || (g.places ?? []).some((p) => p.place_id === placeId));
}
const pairedGame = (list: Game[], s: Studio) => gameForPlace(list, s.placeId);

// ---- the Studio plugin --------------------------------------------------------------------------

// The name Aqua's own installer (aqua plugin install, Setup > Install) writes, so the two never disagree.
const PLUGIN_FILE = "AquaStudioPlugin.rbxmx";
const pluginPath = () => process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Roblox", "Plugins", PLUGIN_FILE) : undefined;
const pluginInstalled = () => { const p = pluginPath(); return !!p && fs.existsSync(p); };

// GET /plugin/AquaStudioPlugin.rbxmx renders the plugin with the server's own address baked in as its default URL
// (the repo copy names the hosted Aqua), so a plugin installed this way points here from its first load.
async function installPlugin(): Promise<string> {
	const out = pluginPath();
	if (!out) throw new Error("no %LOCALAPPDATA%; is Roblox Studio installed on this machine?");
	const r = await fetch(`${aquaUrl()}/plugin/${PLUGIN_FILE}`, { signal: AbortSignal.timeout(8000) });
	if (!r.ok) throw new Error(`plugin download answered HTTP ${r.status}`);
	const xml = await r.text();
	if (!xml.includes("<roblox")) throw new Error("the plugin download was not a Roblox model file");
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, xml);
	return out;
}

// ---- the strip over the dashboard ---------------------------------------------------------------

// paired: every open Studio place is paired (the panel then shows the dashboard instead of the landing page)
export interface Strip { text: string; action?: { label: string; command: string }; paired?: boolean }
const PAIR = { label: "Pair with Aqua", command: "parlay.aqua.pair" };

// The next step, or that there is none. Studios are read from their windows only: a status line must not take
// the Studio MCP seat from Claude Code.
export async function aquaStrip(): Promise<Strip> {
	const r = await api("GET", "/api/games");
	// the hosted Aqua asks for its own sign-in: the dashboard handles that, the button still installs the plugin
	if (r.status === 401) return { text: "Sign in to Aqua in the dashboard, then pair your Studio place.", action: PAIR, paired: false };
	if (!r.ok) return { text: "", paired: false };   // down: the panel shows its unreachable page instead
	const list: Game[] = r.data.games ?? [];
	if (!pluginInstalled()) return { text: "The Aqua Studio plugin is not installed yet; pairing installs it.", action: PAIR, paired: false };
	const studios = await listStudiosViaWindows().catch(() => [] as Studio[]);
	if (!studios.length) return { text: "Open a place in Roblox Studio to pair it with Aqua.", action: PAIR, paired: false };
	const text = studios.map((s) => { const g = pairedGame(list, s); return g ? `${s.name}: paired with ${g.name}` : `${s.name}: not paired`; }).join(" · ");
	const unpaired = studios.some((s) => !pairedGame(list, s));
	return { text, action: unpaired ? PAIR : undefined, paired: !unpaired };
}

// ---- Pair Studio --------------------------------------------------------------------------------

const fail = (m: string) => { log.warn(m); void vscode.window.showWarningMessage(`Parlay: ${m}`); };
const progress = <T>(title: string, task: (token: vscode.CancellationToken) => Promise<T>, cancellable = false) =>
	vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (_p, token) => task(token));

// `probe` every 2 s until it answers truthy, the time runs out, or the token cancels.
async function until<T>(probe: () => Promise<T>, ms: number, token?: vscode.CancellationToken): Promise<T | undefined> {
	const end = Date.now() + ms;
	while (Date.now() < end && !token?.isCancellationRequested) {
		const v = await probe();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 2000));
	}
	return undefined;
}

// Parlay: Pair Roblox Studio with Aqua. Server up, plugin installed, then the plugin's request is watched for,
// its code shown here and approved here. Each step is a line in the Parlay output channel.
async function pairStudio(refresh: () => void, showDashboard: () => void) {
	log.info(`--- Pair Studio with Aqua (${new Date().toLocaleTimeString()})`);
	const url = aquaUrl();
	if (!(await reachable(url))) {
		if (!aquaIsLocal()) { fail(`Aqua is unreachable at ${url}. Check your connection, or set parlay.aquaUrl.`); return; }
		const go = await vscode.window.showInformationMessage(`Aqua is not running at ${url}.`, "Start Aqua");
		if (!go || !startAqua()) return;
		log.info("starting Aqua in its terminal; waiting for it to answer");
		if (!(await progress("Starting Aqua…", () => until(() => reachable(url), 60_000)))) { fail("Aqua did not start within a minute; see the Aqua terminal."); return; }
	}
	let r = await api("GET", "/api/games");
	if (r.status === 401) {
		// The hosted Aqua has its own sign-in and Parlay holds no session there (docs/aqua.md proposes the
		// token exchange). Until then: the plugin from here, the approval in the dashboard, which the panel shows.
		if (!pluginInstalled()) {
			try { log.info(`installed the Aqua Studio plugin: ${await installPlugin()}`); } catch (e) { fail(`Could not install the Aqua Studio plugin: ${(e as Error).message}`); return; }
		}
		showDashboard();
		void vscode.window.showInformationMessage("Sign in to Aqua in the panel, then in Studio: Plugins tab > Aqua QA > \"Pair this place with Aqua\". The dashboard shows the code to approve.",
			{ modal: true, detail: pluginInstalled() ? "The Aqua Studio plugin is installed; Studio loads it when it starts (restart Studio if the Aqua QA button is not there)." : "" });
		return;
	}
	if (!r.ok) { fail(`Aqua did not answer /api/games: ${detail(r)}`); return; }
	const list: Game[] = r.data.games ?? [];
	log.info(`Aqua up at ${url}: ${list.length} game(s): ${list.map((g) => `${g.name} (place ${g.place_id || "none"})`).join(", ") || "none"}`);

	// The place: an open Studio with a saved place id. An unsaved place has none for Aqua to file a key under.
	const studios = await progress("Looking for open Roblox Studio windows…", () => listStudios());
	if (!studios.length) { fail("No Roblox Studio window is open. Open the place, then Pair Studio again."); return; }
	const studio = studios.length === 1 ? studios[0] : (await vscode.window.showQuickPick(
		studios.map((s) => ({ label: s.name, description: pairedGame(list, s) ? `paired with ${pairedGame(list, s)!.name}` : s.placeId ? `placeId ${s.placeId}` : "unsaved place", s })),
		{ placeHolder: "Which Studio place to pair with Aqua?" }))?.s;
	if (!studio) return;
	log.info(`place: ${studio.name} (placeId ${studio.placeId || "none"})`);
	if (!studio.placeId || studio.placeId === "0") { fail(`"${studio.name}" is not saved to Roblox yet, so it has no place id for Aqua to pair. Publish it (File > Publish to Roblox), then Pair Studio again.`); return; }
	const already = pairedGame(list, studio);
	if (already && !(await vscode.window.showInformationMessage(`"${studio.name}" is already paired with ${already.name}.`, { modal: true, detail: "Pair again only after the game's key was rotated." }, "Pair again"))) return;

	// The plugin, from this server so its default URL is this server.
	if (!pluginInstalled()) {
		let installed: string;
		try { installed = await installPlugin(); } catch (e) { fail(`Could not install the Aqua Studio plugin: ${(e as Error).message}`); return; }
		log.info(`installed the Aqua Studio plugin: ${installed}`);
		const ready = await vscode.window.showInformationMessage("Parlay installed the Aqua Studio plugin.",
			{ modal: true, detail: `Studio loads local plugins when it starts: restart Studio (or turn on "Reload plugins on file changes" in Studio Settings), reopen "${studio.name}", allow HTTP to localhost when Studio asks, then continue.` }, "Studio is ready");
		if (!ready) return;
	} else log.info(`plugin present: ${pluginPath()}`);

	// The one click in Studio: only the plugin can store the key it is about to receive. Aqua lists its request
	// (matched to a game on the universe) until it expires, five minutes after the click.
	log.info(`waiting for Studio to ask to pair ${studio.name} (${studio.placeId}): click Pair in Studio's Aqua QA panel`);
	const request = await progress(`In Studio: Plugins tab > Aqua QA > "Pair this place with Aqua" for "${studio.name}". Waiting for that request…`, (token) =>
		until(async () => ((await api("GET", "/api/pairing")).data?.requests ?? [] as PairRequest[]).filter((x: PairRequest) => x.place_id === studio.placeId).pop() as PairRequest | undefined, 5 * 60_000, token), true);
	if (!request) { log.info("no pairing request arrived"); return; }
	log.info(`request ${request.id} for ${request.place_name}: code ${request.code}, Aqua matched ${request.matched_game?.name ?? "no game"}`);

	// The code is how the person sees it is their Studio asking, not another request that arrived just now.
	const answer = await vscode.window.showInformationMessage(`Studio "${request.place_name}" asks to pair with Aqua.  Code: ${request.code}`,
		{ modal: true, detail: "Approve only if Studio's Aqua QA panel shows the same code." }, "Approve", "Deny");
	if (answer === "Deny") { await api("POST", `/api/pairing/${request.id}/deny`); log.info("denied"); return; }
	if (!answer) return;

	// The game it pairs to: Aqua's match on the universe, else a pick from the games Aqua has.
	let slug = request.matched_game?.slug;
	if (!slug) {
		if (!list.length) { fail("Aqua has no game for this place yet. Connect the experience on the dashboard's Setup page (Connect with an API key); the request waits there five minutes."); return; }
		slug = (await vscode.window.showQuickPick(list.map((g) => ({ label: g.name, description: g.slug })), { placeHolder: `No Aqua game matches universe ${request.universe_id}; which game is "${request.place_name}"?` }))?.description;
		if (!slug) return;
	}
	r = await api("POST", `/api/pairing/${request.id}/approve`, { slug });
	if (!r.ok) { fail(`Aqua refused the pairing: ${detail(r)}`); return; }
	const game = String(r.data.game?.name ?? slug);
	log.info(`paired ${request.place_name} (${request.place_id}) with ${game}; the key reached the plugin over its own poll`);
	void vscode.window.showInformationMessage(`"${request.place_name}" is paired with ${game}. Studio's Aqua panel syncs the place to Aqua now.`);
	refresh();
}

export function registerAqua(ctx: vscode.ExtensionContext, refresh: () => void, showDashboard: () => void) {
	secrets = ctx.secrets;
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.aqua.pair", () => pairStudio(refresh, showDashboard)));
}
