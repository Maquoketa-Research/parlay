// Parlay: Claude actions on the code under your cursor (right-click, editor title, and a lens over the
// selection), Aqua and Sonar in the right-hand panel with a Start button when they are down, a Script Sync
// status light, the asset matcher, and the switch that turns the Glass theme into real glass.
// Every action is a Claude Code skill (skills/*/SKILL.md) run in the agent terminal (agents.ts: Claude Code or
// Codex in the Terminal view, one tab that swaps with a handoff note), so the code Claude writes lands in the
// Script Sync folder and shows up in the editor live.
import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aquaStrip, reachable, registerAqua, startAqua, Strip } from "./aqua";
import { registerAquaIssues } from "./aquaIssues";
import { registerDiscordAuth } from "./discord-auth";
import { MeshyView } from "./meshy";
import { registerRobloxAuth } from "./roblox-auth";
import { startSourcemap } from "./sourcemap";
import { addStudioProject } from "./studio";
import { installStudioPlugin } from "./studioPlugin";
import { registerAccounts } from "./accounts";
import { registerAgents, send } from "./agents";
import { registerChat } from "./chat";

const ACTIONS = ["explain", "fix", "validate", "pcall", "extract", "test", "ab"] as const;
const GLASS_THEME = "Parlay Glass";
const LUAU = [{ language: "luau" }, { language: "lua" }, { pattern: "**/*.luau" }];

export function activate(ctx: vscode.ExtensionContext) {
	registerAgents(ctx);   // the agent terminal every send() below types into
	registerChat(ctx);     // the Chat tab: the same two agents headless, one transcript (chat.ts)
	for (const key of ACTIONS) {
		ctx.subscriptions.push(vscode.commands.registerCommand(`parlay.claude.${key}`, (range?: vscode.Range) => runSkill(ctx, key, range)));
	}
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.ask", () => ask(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.claude.match-assets", () => matchAssets(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.installSkills", () => installSkills(ctx, true)));
	// Start from Studio: pick an open place, get its sync folder (or a new one, wired to git), open it here.
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.studio.add", () => addStudioProject(ctx)));

	// The right-hand panel: Aqua (the issues list over the evidence panel; the pairing page and dashboard when no
	// game is known, with a Start button when a local Aqua is down), Meshy, and Sonar.
	const aqua = new UrlView("aquaUrl", "Aqua", startAqua, vscode.Uri.joinPath(ctx.extensionUri, "media", "aqua.png"), aquaStrip);
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("parlay.aqua", aqua));
	registerAqua(ctx, () => aqua.refresh(), () => aqua.showDashboard());   // Pair with Aqua (aqua.ts), from the landing page or the view's title
	registerAquaIssues(ctx, {   // the issues tree (aquaIssues.ts) drives the panel under it
		showEvidence: (body) => aqua.showEvidence(body), showLanding: () => aqua.showLanding(), showDashboard: () => aqua.showDashboard(),
		fix: async (line) => { await installSkills(ctx, false); send(line); },
	});
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
	// window.systemColorTheme (the acrylic follows the theme), security.workspace.trust.enabled (Script Sync folders
	// are the user's own) and terminal.integrated.defaultProfile.windows (the >_ is Claude) are product defaults in
	// product.json: writing them here on a fresh profile made Parlay ask for a restart on its first ever launch.
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
	installStudioPlugin(ctx);   // and gets the rest of the DataModel (the non-script instances) live from Studio
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
// (reachable and startAqua live in aqua.ts with the rest of the Aqua integration)

class UrlView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private render?: (starting?: boolean) => Promise<void>;
	// With a strip provider the view opens on a landing page like the Studio plugin's: the logo large, one line
	// of state, one button (Pair with Aqua). The live page (dashboard) shows on request; "evidence" is a page
	// the issues tree hands over (aquaIssues.ts), shown whenever the folder's game is known.
	private mode: "landing" | "dashboard" | "evidence" = "landing";
	private evidence = "";
	// logo: shown on the landing and placeholder pages, from the extension's media folder.
	// strip: the state line and next step (the Aqua pairing state, aqua.ts); drawn above the live page too.
	constructor(private setting: string, private label: string, private start?: () => boolean, private logo?: vscode.Uri, private strip?: () => Promise<Strip>) {}
	// Re-read the strip and push it into the page; the iframe underneath is not reloaded.
	refresh() {
		if (!this.view?.visible || !this.strip || this.mode === "evidence") return;
		if (this.mode === "landing") { void this.render?.(); return; }
		void this.strip().then((s) => this.view?.webview.postMessage({ type: "strip", ...s }));
	}
	// Show the live page (the dashboard), for when the pairing needs it or the user asks
	showDashboard() { this.mode = "dashboard"; void this.render?.(); }
	showLanding() { this.mode = "landing"; void this.render?.(); }
	// The evidence page: a body (styles included) whose [data-goto] and [data-cmd] elements run Parlay commands.
	showEvidence(body: string) { this.mode = "evidence"; if (body) this.evidence = body; void this.render?.(); }
	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: this.logo ? [vscode.Uri.joinPath(this.logo, "..")] : [] };
		let poll: NodeJS.Timeout | undefined;
		const url = () => vscode.workspace.getConfiguration("parlay").get<string>(this.setting, "");
		const isLocal = (u: string) => { try { return ["localhost", "127.0.0.1"].includes(new URL(u).hostname); } catch { return false; } };
		const render = async (starting = false) => {
			if (this.mode === "evidence") {
				const nonce = Math.random().toString(36).slice(2);
				view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
${this.evidence}
<script nonce="${nonce}">const v=acquireVsCodeApi();document.addEventListener("click",(e)=>{const g=e.target.closest("[data-goto]");if(g){const [p,l]=g.dataset.goto.split("|");v.postMessage({type:"command",command:"parlay.aqua.goto",args:[p,Number(l)]});return;}
const b=e.target.closest("[data-cmd]");if(b)v.postMessage({type:"command",command:b.dataset.cmd,args:b.dataset.args?JSON.parse(b.dataset.args):[]});});</script>`;
				return;
			}
			const u = url();
			let origin = "";
			try { origin = new URL(u).origin; } catch { /* blank frame */ }
			const up = await reachable(u);
			// the landing page: logo, state, one button; the dashboard takes over once every open place is paired
			if (this.strip && this.mode === "landing") {
				const s = up ? await this.strip() : { text: `${this.label} is unreachable at ${u}.`, paired: false };
				if (s.paired) this.mode = "dashboard";
				else {
					const nonce = Math.random().toString(36).slice(2);
					const logo = this.logo ? `<img class="logo" src="${view.webview.asWebviewUri(this.logo)}" alt="">` : "";
					const primary = up ? `<button id="p" data-cmd="${s.action?.command ?? "parlay.aqua.pair"}">${s.action?.label ?? `Pair with ${this.label}`}</button>`
						: (this.start && isLocal(u) ? `<button id="s" ${starting ? "disabled" : ""}>${starting ? "Starting…" : `Start ${this.label}`}</button>` : "");
					view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-descriptionForeground);background:transparent}
.c{text-align:center;max-width:36ch;padding:0 16px}
.logo{width:128px;height:128px;object-fit:contain;margin-bottom:18px}
h1{font-size:20px;font-weight:600;margin:0 0 6px;color:var(--vscode-foreground)}
p{margin:0 0 18px;font-size:12px}
button{padding:9px 24px;border:0;border-radius:999px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit;font-size:13px;font-weight:600}
button:hover{background:var(--vscode-button-hoverBackground)}button[disabled]{opacity:.6;cursor:default}
a{display:block;margin-top:16px;font-size:12px;color:var(--vscode-textLink-foreground);cursor:pointer}a:hover{text-decoration:underline}
</style>
<div class="c">${logo}<h1>${this.label}</h1><p>${(s.text || `Pair your Roblox Studio place with ${this.label}.`).replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;")}</p>${primary}${up ? `<a id="d">Open the dashboard</a>` : ""}</div>
<script nonce="${nonce}">const v=acquireVsCodeApi();document.getElementById("p")?.addEventListener("click",(e)=>v.postMessage({type:"command",command:e.currentTarget.dataset.cmd}));document.getElementById("s")?.addEventListener("click",()=>v.postMessage({type:"start"}));document.getElementById("d")?.addEventListener("click",()=>v.postMessage({type:"dashboard"}));</script>`;
					return;
				}
			}
			if (up) {
				if (poll) { clearInterval(poll); poll = undefined; }
				const nonce = Math.random().toString(36).slice(2);
				view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
html,body{margin:0;height:100vh;background:transparent}body{display:flex;flex-direction:column}iframe{flex:1;width:100%;border:0}
#strip{display:none;align-items:center;gap:10px;padding:6px 10px;font:12px/1.4 var(--vscode-font-family);color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border)}
#strip.on{display:flex}#t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#strip button{padding:3px 10px;border:0;border-radius:999px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;white-space:nowrap}
</style>
<div id="strip"><span id="t"></span><button id="b" hidden></button></div>
<iframe src="${u}" allow="clipboard-write"></iframe>
<script nonce="${nonce}">const v=acquireVsCodeApi(),s=document.getElementById("strip"),t=document.getElementById("t"),b=document.getElementById("b");let cmd="";
window.addEventListener("message",(e)=>{const m=e.data;if(m?.type!=="strip")return;t.textContent=m.text;s.className=m.text?"on":"";b.hidden=!m.action;b.textContent=m.action?.label??"";cmd=m.action?.command??"";});
b.addEventListener("click",()=>cmd&&v.postMessage({type:"command",command:cmd}));</script>`;
				this.refresh();
				return;
			}
			const nonce = Math.random().toString(36).slice(2);
			const button = this.start && isLocal(u)   // a hosted Aqua cannot be started from here
				? `<button id="s" ${starting ? "disabled" : ""}>${starting ? "Starting…" : `Start ${this.label}`}</button>`
				: "";
			const logo = this.logo ? `<img class="logo" src="${view.webview.asWebviewUri(this.logo)}" alt="">` : "";
			view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-descriptionForeground);background:transparent}
.c{text-align:center;max-width:32ch}
.logo{width:72px;height:72px;object-fit:contain;margin-bottom:14px;opacity:.95}
b{display:block;color:var(--vscode-foreground);font-weight:600;margin-bottom:6px}
code{font-family:var(--vscode-editor-font-family);font-size:12px}
button{margin-top:14px;padding:6px 16px;border:0;border-radius:999px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
</style>
<div class="c">${logo}<b>${this.label} is not running</b>Nothing answered at <code>${u}</code>.${button}</div>
<script nonce="${nonce}">const v=acquireVsCodeApi();document.getElementById("s")?.addEventListener("click",()=>v.postMessage({type:"start"}));</script>`;
		};
		view.webview.onDidReceiveMessage((m) => {
			// the strip's button and the evidence page run Parlay commands (only ours: the page is an iframe of a web app)
			if (m?.type === "command" && typeof m.command === "string" && m.command.startsWith("parlay.")) { void vscode.commands.executeCommand(m.command, ...(Array.isArray(m.args) ? m.args : [])); return; }
			if (m?.type === "dashboard") { this.showDashboard(); return; }
			if (m?.type !== "start" || !this.start) return;
			if (!this.start()) return;
			void render(true);
			let tries = 0;
			poll = setInterval(() => { tries++; void render(tries < 30); if (tries >= 30 && poll) { clearInterval(poll); poll = undefined; } }, 2000);
		});
		this.render = render;
		void render();
		const sub = vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`parlay.${this.setting}`)) void render(); });
		view.onDidChangeVisibility(() => { if (view.visible) void render(); });
		const tick = setInterval(() => this.refresh(), 60_000);   // Studio opened or closed, a pairing made elsewhere
		view.onDidDispose(() => { sub.dispose(); clearInterval(tick); if (poll) clearInterval(poll); this.view = undefined; });
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
