// Parlay: Claude actions on the code under your cursor (right-click, editor title, and a lens over the
// selection), Aqua and Sonar in the right-hand panel with a Start button when they are down, a Script Sync
// status light, the asset matcher, and the switch that turns the Glass theme into real glass.
// Every action is a Claude Code skill (skills/*/SKILL.md) run in a terminal, so the code Claude writes
// lands in the Script Sync folder and shows up in the editor live.
import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { registerDiscordAuth } from "./discord-auth";
import { MeshyView } from "./meshy";
import { registerRobloxAuth } from "./roblox-auth";
import { startSourcemap } from "./sourcemap";
import { addStudioProject } from "./studio";
import { registerAccounts } from "./accounts";

const ACTIONS = ["explain", "fix", "validate", "pcall", "extract", "test", "ab"] as const;
const GLASS_THEME = "Parlay Glass";
const LUAU = [{ language: "luau" }, { language: "lua" }, { pattern: "**/*.luau" }];

let claudeTerminal: vscode.Terminal | undefined; // the one terminal Claude Code runs in

export function activate(ctx: vscode.ExtensionContext) {
	for (const key of ACTIONS) {
		ctx.subscriptions.push(vscode.commands.registerCommand(`parlay.claude.${key}`, (range?: vscode.Range) => runSkill(ctx, key, range)));
	}
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.ask", () => ask(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.claude.match-assets", () => matchAssets(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.installSkills", () => installSkills(ctx, true)));
	// Start from Studio: pick an open place, get its sync folder (or a new one, wired to git), open it here.
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.studio.add", () => addStudioProject(ctx)));
	ctx.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { if (t === claudeTerminal) claudeTerminal = undefined; }));

	// The right-hand panel: Aqua (with a Start button when it is down), Meshy, and Sonar.
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("parlay.aqua", new UrlView("aquaUrl", "Aqua", startAqua)));
	const meshy = new MeshyView(ctx, async (assetId, name) => { await installSkills(ctx, false); send(`/parlay-insert-asset ${assetId} ${clean(name)}`); });
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("parlay.meshy", meshy, { webviewOptions: { retainContextWhenHidden: true } }));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.meshy.setKey", () => meshy.setKey("meshy")));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.roblox.setKey", () => meshy.setKey("roblox")));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.openai.setKey", () => meshy.setKey("openai")));
	// Log in with Roblox: the account in the Accounts menu; Open Cloud calls try it before the stored API key.
	const roblox = registerRobloxAuth(ctx);
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.roblox.signIn", () => roblox.signIn()));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.roblox.signOut", () => roblox.signOut()));
	// Log in with Discord: identity only (who you are, with avatar), for the Accounts menu and the Accounts page.
	const discord = registerDiscordAuth(ctx);
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.discord.signIn", () => discord.signIn()));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.discord.signOut", () => discord.signOut()));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.claude.insert-asset", async () => {
		const id = await vscode.window.showInputBox({ prompt: "Roblox asset id to insert into the open Studio", placeHolder: "1234567890" });
		if (!id?.trim()) return;
		await installSkills(ctx, false);
		send(`/parlay-insert-asset ${clean(id.trim())}`);
	}));
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("parlay.sonar", new UrlView("sonarUrl", "Sonar")));
	// Accounts: every login and key on one page (the account in the header opens it)
	registerAccounts(ctx);
	if (!ctx.globalState.get("firstRunDone")) {
		void ctx.globalState.update("firstRunDone", true);
		void firstRun();
	}
	// Windows draws the glass acrylic in the OS colour mode; a light-mode desktop turns a dark theme to grey mud.
	// "auto" makes the native tint follow the colour theme (dark for Dark/Glass/Aqua, light for Paper).
	void ensureUserSetting("window.systemColorTheme", "auto");
	// The folders Parlay opens are the user's own Script Sync folders; Restricted Mode would only switch Parlay off
	// in them (and did, before the extension declared untrustedWorkspaces support). Application scope: user settings.
	void ensureUserSetting("security.workspace.trust.enabled", false);
	// Layout v2: Parlay is its own container in the right sidebar; the terminal panel goes back to the bottom.
	if (!ctx.globalState.get("layoutV2Done")) {
		void ctx.globalState.update("layoutV2Done", true);
		void (async () => {
			await vscode.commands.executeCommand("workbench.action.positionPanelBottom");
			await vscode.commands.executeCommand("parlay.aqua.focus");
		})();
	}
	void ensureSeleneConfig();
	startSourcemap(ctx);   // luau-lsp resolves instance requires from it
	// a folder that was empty when Studio started syncing into it gets its Selene config as the first script lands
	const firstScript = vscode.workspace.createFileSystemWatcher("**/*.luau", false, true, true);
	ctx.subscriptions.push(firstScript, firstScript.onDidCreate(() => void ensureSeleneConfig()));

	// The lens over the selection: Explain · Fix · Validate, without a right-click.
	const lens = new SelectionLens();
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(LUAU, lens));
	ctx.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => lens.refresh()));

	// Glass: the theme is a look, the window material is a main-process option (fork patch). Keep them in step.
	void syncGlass();
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("workbench.colorTheme")) void syncGlass(); }));

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = "parlay.installSkills";
	ctx.subscriptions.push(status);
	void refreshStatus(status);
	const timer = setInterval(() => void refreshStatus(status), 30_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function ensureUserSetting(key: string, value: unknown) {
	const cfg = vscode.workspace.getConfiguration();
	if (cfg.inspect(key)?.globalValue === undefined) await cfg.update(key, value, vscode.ConfigurationTarget.Global);
}

// ---- first run ----------------------------------------------------------------------------------

// The look that configurationDefaults cannot give us: VS Code refuses extension defaults for application-scoped
// settings (window.*), and the panel position is layout state, not a setting. Written once to the user's
// settings, so they can change any of it afterwards.
async function firstRun() {
	const cfg = vscode.workspace.getConfiguration();
	// (luau-lsp.sourcemap.autogenerate lives in configurationDefaults: it has to be off before luau-lsp starts)
	const want: Record<string, unknown> = { "editor.minimap.enabled": false };
	for (const [k, v] of Object.entries(want)) {
		if (cfg.inspect(k)?.globalValue === undefined) await cfg.update(k, v, vscode.ConfigurationTarget.Global);
	}
	await vscode.commands.executeCommand("parlay.aqua.focus");   // opens the Parlay sidebar on the right
}

// Selene only parses Luau syntax (type annotations, `::`, string interpolation) when the project's selene.toml
// selects the Roblox standard. Script Sync folders have no such file, so every typed script lit up as a parse
// error. Add the one-line config once for workspaces that look like a Roblox place.
async function ensureSeleneConfig() {
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!ws) return;
	const toml = path.join(ws, "selene.toml");
	if (fs.existsSync(toml)) return;
	const roblox = ["ServerScriptService", "ReplicatedStorage", "StarterPlayer", "default.project.json"].some((n) => fs.existsSync(path.join(ws, n)));
	if (!roblox) return;
	fs.writeFileSync(toml, 'std = "roblox"\n');
	void vscode.window.showInformationMessage("Parlay: added selene.toml (std = roblox) so Selene reads Luau. Delete it if you keep lint config elsewhere.");
}

// ---- the actions --------------------------------------------------------------------------------

function target(range?: vscode.Range): string | undefined {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { void vscode.window.showInformationMessage("Open a script first."); return; }
	const rel = vscode.workspace.asRelativePath(ed.document.uri, false).replace(/\\/g, "/");
	const r = range ?? ed.selection;
	return `${rel}:${r.start.line + 1}-${r.end.line + 1}`;
}

async function runSkill(ctx: vscode.ExtensionContext, key: string, range?: vscode.Range) {
	const t = target(range); if (!t) return;
	await installSkills(ctx, false);
	send(`/parlay-${key} ${t}`);
}

async function ask(ctx: vscode.ExtensionContext) {
	const t = target(); if (!t) return;
	const q = await vscode.window.showInputBox({ prompt: `Ask Claude about ${t}`, placeHolder: "What does this do when two players buy at once?" });
	if (!q) return;
	await installSkills(ctx, false);
	send(`/parlay-explain ${t} ${clean(q)}`);
}

// Screenshot in, six in-scene candidates out (skills/parlay-match-assets). Empty path = capture from Studio.
async function matchAssets(ctx: vscode.ExtensionContext) {
	const p = await vscode.window.showInputBox({
		prompt: "Path to a Studio screenshot to match assets against. Leave empty to capture the open Studio viewport.",
		placeHolder: "C:\\Users\\you\\Pictures\\spawn.png",
	});
	if (p === undefined) return;
	await installSkills(ctx, false);
	send(`/parlay-match-assets ${p.trim() ? clean(p.trim()) : "capture"}`);
}

const clean = (s: string) => s.replace(/["\r\n]/g, "'");

// One terminal, one Claude Code session. The first send starts claude with the slash command; later
// sends type into the running session. ponytail: if the user exits claude in that terminal, the next
// send goes to the shell and fails visibly; close the terminal and try again. A pty check can come later.
function send(line: string) {
	const cmd = vscode.workspace.getConfiguration("parlay").get<string>("claudeCommand", "claude");
	const fresh = !claudeTerminal;
	claudeTerminal ??= vscode.window.createTerminal({ name: "Claude", cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
	claudeTerminal.show(true);
	claudeTerminal.sendText(fresh ? `${cmd} "${line}"` : line, true);
}

// The skills ship with the extension and are installed user-wide (~/.claude/skills/parlay-*), so every
// workspace has them and no project folder is written to. Re-copied only when the extension version changes.
async function installSkills(ctx: vscode.ExtensionContext, announce: boolean) {
	const src = path.join(ctx.extensionPath, "skills");
	const dst = path.join(os.homedir(), ".claude", "skills");
	const stampKey = "skillsVersion";
	const version = (ctx.extension.packageJSON as { version: string }).version;
	if (!announce && ctx.globalState.get(stampKey) === version && fs.existsSync(path.join(dst, "parlay-fix", "SKILL.md"))) return;
	fs.mkdirSync(dst, { recursive: true });
	for (const name of fs.readdirSync(src)) fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
	await ctx.globalState.update(stampKey, version);
	if (announce) void vscode.window.showInformationMessage(`Parlay: Claude skills installed to ${dst}`);
}

// ---- the selection lens -------------------------------------------------------------------------

class SelectionLens implements vscode.CodeLensProvider {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.changed.event;
	refresh() { this.changed.fire(); }
	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const ed = vscode.window.activeTextEditor;
		if (!ed || ed.document !== doc || ed.selection.isEmpty || ed.selection.isSingleLine) return [];
		const range = new vscode.Range(ed.selection.start.line, 0, ed.selection.start.line, 0);
		const sel = new vscode.Range(ed.selection.start, ed.selection.end);
		return [
			new vscode.CodeLens(range, { title: "Claude: Explain", command: "parlay.claude.explain", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Fix", command: "parlay.claude.fix", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Validate on server", command: "parlay.claude.validate", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Ask…", command: "parlay.ask" }),
		];
	}
}

// ---- glass --------------------------------------------------------------------------------------

// parlay.glass is what the fork reads (fork/patches/parlay-glass.patch): the main process swaps the window's
// acrylic and the workbench its transparency class as soon as the setting changes, so the theme switch is live.
async function syncGlass() {
	const cfg = vscode.workspace.getConfiguration();
	const want = cfg.get<string>("workbench.colorTheme") === GLASS_THEME;
	if (want === (cfg.get<boolean>("parlay.glass") === true)) return;
	await cfg.update("parlay.glass", want, vscode.ConfigurationTarget.Global);
}

// ---- the panel views (Aqua, Sonar) --------------------------------------------------------------

function reachable(url: string): Promise<boolean> {
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
	const set = vscode.workspace.getConfiguration("parlay").get<string>("aquaRepo", "");
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const guesses = [set, ws ? path.join(path.dirname(ws), "aqua") : "", path.join(os.homedir(), "Documents", "GitHub", "aqua")];
	return guesses.find((g) => g && fs.existsSync(path.join(g, "pyproject.toml")));
}

function startAqua(): boolean {
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

class UrlView implements vscode.WebviewViewProvider {
	constructor(private setting: string, private label: string, private start?: () => boolean) {}
	resolveWebviewView(view: vscode.WebviewView) {
		view.webview.options = { enableScripts: true };
		let poll: NodeJS.Timeout | undefined;
		const url = () => vscode.workspace.getConfiguration("parlay").get<string>(this.setting, "");
		const render = async (starting = false) => {
			const u = url();
			let origin = "";
			try { origin = new URL(u).origin; } catch { /* blank frame */ }
			if (await reachable(u)) {
				if (poll) { clearInterval(poll); poll = undefined; }
				view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'">
<style>html,body,iframe{margin:0;width:100%;height:100vh;border:0;background:transparent}</style>
<iframe src="${u}" allow="clipboard-write"></iframe>`;
				return;
			}
			const nonce = Math.random().toString(36).slice(2);
			const button = this.start
				? `<button id="s" ${starting ? "disabled" : ""}>${starting ? "Starting…" : `Start ${this.label}`}</button>`
				: "";
			view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-descriptionForeground);background:transparent}
.c{text-align:center;max-width:32ch}
b{display:block;color:var(--vscode-foreground);font-weight:600;margin-bottom:6px}
code{font-family:var(--vscode-editor-font-family);font-size:12px}
button{margin-top:14px;padding:6px 16px;border:0;border-radius:999px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
</style>
<div class="c"><b>${this.label} is not running</b>Nothing answered at <code>${u}</code>.${button}</div>
<script nonce="${nonce}">const v=acquireVsCodeApi();document.getElementById("s")?.addEventListener("click",()=>v.postMessage({type:"start"}));</script>`;
		};
		view.webview.onDidReceiveMessage((m) => {
			if (m?.type !== "start" || !this.start) return;
			if (!this.start()) return;
			void render(true);
			let tries = 0;
			poll = setInterval(() => { tries++; void render(tries < 30); if (tries >= 30 && poll) { clearInterval(poll); poll = undefined; } }, 2000);
		});
		void render();
		const sub = vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`parlay.${this.setting}`)) void render(); });
		view.onDidChangeVisibility(() => { if (view.visible) void render(); });
		view.onDidDispose(() => { sub.dispose(); if (poll) clearInterval(poll); });
	}
}

// ---- Script Sync status -------------------------------------------------------------------------

// Studio keeps its Script Sync mappings in HKCU\Software\Roblox\RobloxStudio as
// File_Sync_Persistence_Record_V1:<placeId>:<guid> values (JSON with the folder path). Nothing on disk
// says "this folder is synced", so we look for the workspace path in that registry text.
// ponytail: substring match on the raw `reg query` text; parse the JSON records if this misfires.
async function refreshStatus(status: vscode.StatusBarItem) {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) { status.hide(); return; }
	let on = false;
	if (process.platform === "win32") {
		const text = await new Promise<string>((res) =>
			execFile("reg", ["query", "HKCU\\Software\\Roblox\\RobloxStudio"], { windowsHide: true, maxBuffer: 4 << 20 }, (_e, out) => res(String(out ?? ""))));
		const plain = folder.toLowerCase(), escaped = plain.replace(/\\/g, "\\\\"), fwd = plain.replace(/\\/g, "/");
		const hay = text.toLowerCase();
		on = hay.includes(plain) || hay.includes(escaped) || hay.includes(fwd);
	}
	status.text = on ? "$(sync) Script Sync on" : "$(sync-ignored) Script Sync off";
	status.tooltip = on
		? "Roblox Studio syncs this folder. Claude's edits land in Studio on save."
		: "Studio is not syncing this folder. In Studio: right-click a Folder, Sync to..., pick this folder.";
	status.show();
}

export function deactivate() {}
