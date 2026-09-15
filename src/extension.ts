// Drydock IDE: Claude actions on the code under your cursor, Aqua and Sonar in the right-hand panel,
// and a Script Sync status light. Every action is a Claude Code skill (skills/*/SKILL.md) run in a
// terminal, so the code Claude writes lands in the Script Sync folder and shows up in the editor live.
import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ACTIONS = ["explain", "fix", "validate", "pcall", "extract", "test", "ab"] as const;

let claudeTerminal: vscode.Terminal | undefined; // the one terminal Claude Code runs in

export function activate(ctx: vscode.ExtensionContext) {
	for (const key of ACTIONS) {
		ctx.subscriptions.push(vscode.commands.registerCommand(`drydock.claude.${key}`, () => runSkill(ctx, key)));
	}
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.ask", () => ask(ctx)));
	ctx.subscriptions.push(vscode.commands.registerCommand("drydock.installSkills", () => installSkills(ctx, true)));
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("drydock.aqua", new UrlView("aquaUrl")));
	ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("drydock.sonar", new UrlView("sonarUrl")));
	ctx.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { if (t === claudeTerminal) claudeTerminal = undefined; }));

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.command = "drydock.installSkills";
	ctx.subscriptions.push(status);
	void refreshStatus(status);
	const timer = setInterval(() => void refreshStatus(status), 30_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// ---- the actions --------------------------------------------------------------------------------

function target(): string | undefined {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { void vscode.window.showInformationMessage("Open a script first."); return; }
	const rel = vscode.workspace.asRelativePath(ed.document.uri, false).replace(/\\/g, "/");
	const a = ed.selection.start.line + 1, b = ed.selection.end.line + 1;
	return `${rel}:${a}-${b}`;
}

async function runSkill(ctx: vscode.ExtensionContext, key: string) {
	const t = target(); if (!t) return;
	await installSkills(ctx, false);
	send(`/drydock-${key} ${t}`);
}

async function ask(ctx: vscode.ExtensionContext) {
	const t = target(); if (!t) return;
	const q = await vscode.window.showInputBox({ prompt: `Ask Claude about ${t}`, placeHolder: "What does this do when two players buy at once?" });
	if (!q) return;
	await installSkills(ctx, false);
	send(`/drydock-explain ${t} ${q.replace(/["\r\n]/g, "'")}`);
}

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

// ---- the panel views (Aqua, Sonar) --------------------------------------------------------------

class UrlView implements vscode.WebviewViewProvider {
	constructor(private setting: string) {}
	resolveWebviewView(view: vscode.WebviewView) {
		view.webview.options = { enableScripts: true };
		const render = () => {
			const url = vscode.workspace.getConfiguration("drydock").get<string>(this.setting, "");
			let origin = "";
			try { origin = new URL(url).origin; } catch { /* leave the frame blank */ }
			view.webview.html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'">
<style>html,body,iframe{margin:0;width:100%;height:100vh;border:0;background:transparent}</style>
<iframe src="${url}" allow="clipboard-write"></iframe>`;
		};
		render();
		const sub = vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`drydock.${this.setting}`)) render(); });
		view.onDidDispose(() => sub.dispose());
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
