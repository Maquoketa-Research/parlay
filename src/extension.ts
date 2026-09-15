// Drydock IDE: Claude actions on the code under your cursor (right-click, editor title, and a lens over the
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
import { MeshyView } from "./meshy";

const ACTIONS = ["explain", "fix", "validate", "pcall", "extract", "test", "ab"] as const;
const GLASS_THEME = "Drydock Glass";
const LUAU = [{ language: "luau" }, { language: "lua" }, { pattern: "**/*.luau" }];

let claudeTerminal: vscode.Terminal | undefined; // the one terminal Claude Code runs in

export function activate(ctx: vscode.ExtensionContext) {
	for (const key of ACTIONS) {
		ctx.subscriptions.push(vscode.commands.registerCommand(`drydock.claude.${key}`, (range?: vscode.Range) => runSkill(ctx, key, range)));
	}
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.ask", () => ask(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.claude.match-assets", () => matchAssets(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.installSkills", () => installSkills(ctx, true)));
	ctx.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { if (t === claudeTerminal) claudeTerminal = undefined; }));

	// The right-hand panel: Aqua (with a Start button when it is down), Meshy, and Sonar.
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("drydock.aqua", new UrlView("aquaUrl", "Aqua", startAqua)));
	const meshy = new MeshyView(ctx, async (assetId, name) => { await installSkills(ctx, false); send(`/drydock-insert-asset ${assetId} ${clean(name)}`); });
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("drydock.meshy", meshy, { webviewOptions: { retainContextWhenHidden: true } }));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.meshy.setKey", () => meshy.setKey("meshy")));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.roblox.setKey", () => meshy.setKey("roblox")));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.claude.insert-asset", async () => {
		const id = await vscode.window.showInputBox({ prompt: "Roblox asset id to insert into the open Studio", placeHolder: "1234567890" });
		if (!id?.trim()) return;
		await installSkills(ctx, false);
		send(`/drydock-insert-asset ${clean(id.trim())}`);
	}));
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("drydock.sonar", new UrlView("sonarUrl", "Sonar")));
	if (!ctx.globalState.get("firstRunDone")) {
		void ctx.globalState.update("firstRunDone", true);
		void firstRun();
	}

	// The lens over the selection: Explain · Fix · Validate, without a right-click.
	const lens = new SelectionLens();
	ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(LUAU, lens));
	ctx.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(() => lens.refresh()));

	// Glass: the theme is a look, the window material is a main-process option (fork patch). Keep them in step.
	void syncGlass();
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("workbench.colorTheme")) void syncGlass(); }));

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = "drydock.installSkills";
	ctx.subscriptions.push(status);
	void refreshStatus(status);
	const timer = setInterval(() => void refreshStatus(status), 30_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// ---- first run ----------------------------------------------------------------------------------

// The look that configurationDefaults cannot give us: VS Code refuses extension defaults for application-scoped
// settings (window.*), and the panel position is layout state, not a setting. Written once to the user's
// settings, so they can change any of it afterwards.
async function firstRun() {
	const cfg = vscode.workspace.getConfiguration();
	const want: Record<string, unknown> = {
		"window.menuBarVisibility": "compact",   // the menu folds into a hamburger in the activity bar; applies live
		"editor.minimap.enabled": false,
		// Script Sync folders have no Rojo project; stop luau-lsp asking for one. The Studio companion plugin
		// can supply the DataModel later (luau-lsp's own "Setup Plugin" flow).
		"luau-lsp.sourcemap.autogenerate": false,
	};
	for (const [k, v] of Object.entries(want)) {
		if (cfg.inspect(k)?.globalValue === undefined) await cfg.update(k, v, vscode.ConfigurationTarget.Global);
	}
	await vscode.commands.executeCommand("workbench.action.positionPanelRight");
	await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
	await vscode.commands.executeCommand("drydock.aqua.focus");
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
	send(`/drydock-${key} ${t}`);
}

async function ask(ctx: vscode.ExtensionContext) {
	const t = target(); if (!t) return;
	const q = await vscode.window.showInputBox({ prompt: `Ask Claude about ${t}`, placeHolder: "What does this do when two players buy at once?" });
	if (!q) return;
	await installSkills(ctx, false);
	send(`/drydock-explain ${t} ${clean(q)}`);
}

// Screenshot in, six in-scene candidates out (skills/drydock-match-assets). Empty path = capture from Studio.
async function matchAssets(ctx: vscode.ExtensionContext) {
	const p = await vscode.window.showInputBox({
		prompt: "Path to a Studio screenshot to match assets against. Leave empty to capture the open Studio viewport.",
		placeHolder: "C:\\Users\\you\\Pictures\\spawn.png",
	});
	if (p === undefined) return;
	await installSkills(ctx, false);
	send(`/drydock-match-assets ${p.trim() ? clean(p.trim()) : "capture"}`);
}

const clean = (s: string) => s.replace(/["\r\n]/g, "'");

// One terminal, one Claude Code session. The first send starts claude with the slash command; later
// sends type into the running session. ponytail: if the user exits claude in that terminal, the next
// send goes to the shell and fails visibly; close the terminal and try again. A pty check can come later.
function send(line: string) {
	const cmd = vscode.workspace.getConfiguration("drydock").get<string>("claudeCommand", "claude");
	const fresh = !claudeTerminal;
	claudeTerminal ??= vscode.window.createTerminal({ name: "Claude", cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
	claudeTerminal.show(true);
	claudeTerminal.sendText(fresh ? `${cmd} "${line}"` : line, true);
}

// The skills ship with the extension and are installed user-wide (~/.claude/skills/drydock-*), so every
// workspace has them and no project folder is written to. Re-copied only when the extension version changes.
async function installSkills(ctx: vscode.ExtensionContext, announce: boolean) {
	const src = path.join(ctx.extensionPath, "skills");
	const dst = path.join(os.homedir(), ".claude", "skills");
	const stampKey = "skillsVersion";
	const version = (ctx.extension.packageJSON as { version: string }).version;
	if (!announce && ctx.globalState.get(stampKey) === version && fs.existsSync(path.join(dst, "drydock-fix", "SKILL.md"))) return;
	fs.mkdirSync(dst, { recursive: true });
	for (const name of fs.readdirSync(src)) fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
	await ctx.globalState.update(stampKey, version);
	if (announce) void vscode.window.showInformationMessage(`Drydock: Claude skills installed to ${dst}`);
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
			new vscode.CodeLens(range, { title: "Claude: Explain", command: "drydock.claude.explain", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Fix", command: "drydock.claude.fix", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Validate on server", command: "drydock.claude.validate", arguments: [sel] }),
			new vscode.CodeLens(range, { title: "Ask…", command: "drydock.ask" }),
		];
	}
}

// ---- glass --------------------------------------------------------------------------------------

// drydock.glass is read by the main process when a window is created (fork/patches/drydock-glass.patch),
// so a change shows in the next window, not this one.
async function syncGlass() {
	const cfg = vscode.workspace.getConfiguration();
	const want = cfg.get<string>("workbench.colorTheme") === GLASS_THEME;
	const has = cfg.get<boolean>("drydock.glass") === true;
	if (want === has) return;
	await cfg.update("drydock.glass", want, vscode.ConfigurationTarget.Global);
	if (process.platform !== "win32") return;
	const pick = await vscode.window.showInformationMessage(
		want ? "Glass is on for windows opened from now on." : "Glass is off for windows opened from now on.",
		"New Window");
	if (pick) void vscode.commands.executeCommand("workbench.action.newWindow");
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
	const set = vscode.workspace.getConfiguration("drydock").get<string>("aquaRepo", "");
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const guesses = [set, ws ? path.join(path.dirname(ws), "aqua") : "", path.join(os.homedir(), "Documents", "GitHub", "aqua")];
	return guesses.find((g) => g && fs.existsSync(path.join(g, "pyproject.toml")));
}

function startAqua(): boolean {
	const repo = aquaRepo();
	if (!repo) {
		void vscode.window.showWarningMessage("Drydock: aqua checkout not found. Set drydock.aquaRepo to its folder.", "Open Settings")
			.then((p) => { if (p) void vscode.commands.executeCommand("workbench.action.openSettings", "drydock.aquaRepo"); });
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
		const url = () => vscode.workspace.getConfiguration("drydock").get<string>(this.setting, "");
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
		const sub = vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`drydock.${this.setting}`)) void render(); });
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
