// Parlay: Accounts. One page for everything Parlay signs in to or holds a key for: Roblox (login, plus the Open
// Cloud key that the Starter-container sync needs), Discord (login), Meshy (key), Claude (Claude Code's own
// login), GPT (Codex's login and the OpenAI key the image steps use). It opens from the account in the header
// and from the command palette. Every row shows who is linked and the one or two actions that change it, and
// the page redraws when a session or a key changes. Logins that belong to a CLI run in a terminal, so the CLI
// does its own browser dance and nothing about its credentials passes through Parlay.
import * as vscode from "vscode";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { exe } from "./agents";
import type { Agent } from "./handoff";
import { SCOPES as ROBLOX_SCOPES } from "./roblox-auth";

type Msg = { cmd: string } | { clear: string } | { shell: string } | { agent: Agent; args: string[] };
// icon: a codicon for the header menu; brand: a mark in media/brands for the page (CC0 from simpleicons, Meshy's favicon)
interface Row { title: string; status: string; ok: boolean; note?: string; avatar?: string; icon: string; brand?: string; actions: { label: string; msg: Msg; quiet?: boolean }[] }

export function registerAccounts(ctx: vscode.ExtensionContext) {
	let panel: vscode.WebviewPanel | undefined;
	const render = async () => {
		if (!panel) return;
		const brand = (f: string) => panel!.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "brands", f)).toString();
		panel.webview.html = html(await rows(ctx), panel.webview.cspSource, brand);
	};
	ctx.subscriptions.push(vscode.authentication.onDidChangeSessions(() => void render()), ctx.secrets.onDidChange(() => void render()));
	onCli = () => void render();
	void refreshCli(exe("claude"));   // warm the cache at startup
	// one action, from the page or from the header menu
	const act = async (m: Msg) => {
		try {
			if ("cmd" in m) { await vscode.commands.executeCommand(m.cmd); }
			else if ("clear" in m) { await ctx.secrets.delete(m.clear); }
			else if ("agent" in m) { vscode.window.createTerminal({ name: "Parlay sign-in", shellPath: exe(m.agent), shellArgs: m.args }).show(); }
			else if ("shell" in m) { const t = vscode.window.createTerminal({ name: "Parlay sign-in" }); t.show(); t.sendText(m.shell); }
		} catch (e) { void vscode.window.showErrorMessage(`Parlay: ${(e as Error).message}`); }
		// CLIs need a moment; sessions and keys redraw on their own events too
		setTimeout(() => { cliState.at = 0; void refreshCli(exe("claude")); void render(); }, 1500);
	};
	// the header's avatar menu (parlayAccount.ts in the workbench) asks for the rows and runs the actions
	// the brand marks go along as data URIs: the header popover is workbench code with no access to extension files
	const brandData = (f: string) => {
		try { const b = fs.readFileSync(path.join(ctx.extensionPath, "media", "brands", f)); return `data:${f.endsWith(".svg") ? "image/svg+xml" : "image/x-icon"};base64,${b.toString("base64")}`; } catch { return undefined; }
	};
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.accounts.summary", async () => (await rows(ctx)).map((r) => ({ ...r, brandData: r.brand ? brandData(r.brand) : undefined }))));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.accounts.do", (m: Msg) => act(m)));
	ctx.subscriptions.push(vscode.commands.registerCommand("parlay.accounts", async () => {
		if (panel) { panel.reveal(); return; }
		panel = vscode.window.createWebviewPanel("parlay.accounts", "Accounts", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "aqua.svg");
		panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
		panel.webview.onDidReceiveMessage((m: Msg) => void act(m), null, ctx.subscriptions);
		await render();
	}));
}

// ---- what is linked --------------------------------------------------------------------------------------

// The CLIs' own answers about who is logged in, cached: asking takes seconds, and the header popover has to open
// at once. Refreshed at most every 20 s, in the background; whoever asked next sees the new answer.
type CliStatus = { ok: boolean; status: string; installed: boolean };
const cliState: { claude: CliStatus; codex: CliStatus; at: number; busy?: Promise<void> } = {
	claude: { ok: false, status: "Checking…", installed: true }, codex: { ok: false, status: "Checking…", installed: true }, at: 0,
};
let onCli: (() => void) | undefined;   // the page redraws when a fresh answer lands
function refreshCli(claudeCmd: string): Promise<void> {
	if (cliState.busy) return cliState.busy;
	if (Date.now() - cliState.at < 20_000) return Promise.resolve();
	return cliState.busy = Promise.all([claudeStatus(claudeCmd), codexStatus()]).then(([c, x]) => {
		const changed = JSON.stringify([c, x]) !== JSON.stringify([cliState.claude, cliState.codex]);
		cliState.claude = c; cliState.codex = x; cliState.at = Date.now();
		if (changed) onCli?.();
	}).finally(() => { cliState.busy = undefined; });
}

async function rows(ctx: vscode.ExtensionContext): Promise<Row[]> {
	const session = async (provider: string, scopes: string[]) => {
		try { return await vscode.authentication.getSession(provider, scopes, { silent: true }); } catch { return undefined; }   // provider absent = not linked
	};
	const has = async (k: string) => !!(await ctx.secrets.get(k));
	const claudeCmd = exe("claude");
	// sessions and keys are milliseconds; the two CLI status calls are seconds, so they come from the cache below
	const [roblox, discord, robloxKey, meshyKey, openaiKey] = await Promise.all([
		session("roblox", ROBLOX_SCOPES), session("discord", ["identify"]),
		has("parlay.robloxApiKey"), has("parlay.meshyApiKey"), has("parlay.openaiApiKey"),
	]);
	void refreshCli(claudeCmd);
	const { claude, codex } = cliState;
	const avatar = (s?: vscode.AuthenticationSession) => (s?.account as { icon?: vscode.Uri } | undefined)?.icon?.toString();
	const keyActions = (k: string, cmd: string, set: boolean) => set
		? [{ label: "Replace key", msg: { cmd }, quiet: true }, { label: "Remove", msg: { clear: k }, quiet: true }]
		: [{ label: "Set key", msg: { cmd } }];
	return [
		{
			title: "Roblox", status: roblox ? roblox.account.label : "Not signed in", ok: !!roblox, avatar: avatar(roblox), icon: "game", brand: "roblox.svg",
			note: robloxKey ? "Open Cloud key set: Starter containers sync too." : "Open Cloud key not set: StarterPlayerScripts and StarterCharacterScripts stay a right-click in Studio.",
			actions: [
				roblox ? { label: "Sign out", msg: { cmd: "parlay.roblox.signOut" }, quiet: true } : { label: "Sign in", msg: { cmd: "parlay.roblox.signIn" } },
				...keyActions("parlay.robloxApiKey", "parlay.roblox.setKey", robloxKey).map((a) => ({ ...a, label: a.label.replace("key", "Open Cloud key") })),
			],
		},
		{
			title: "Discord", status: discord ? discord.account.label : "Not linked", ok: !!discord, avatar: avatar(discord), icon: "comment-discussion", brand: "discord.svg",
			actions: [discord ? { label: "Unlink", msg: { cmd: "parlay.discord.signOut" }, quiet: true } : { label: "Link Discord", msg: { cmd: "parlay.discord.signIn" } }],
		},
		{
			title: "Meshy", status: meshyKey ? "API key set" : "No API key", ok: meshyKey, note: "Turns approved concept images into meshes.", icon: "package", brand: "meshy.ico",
			actions: keyActions("parlay.meshyApiKey", "parlay.meshy.setKey", meshyKey),
		},
		{
			title: "Claude", status: claude.status, ok: claude.ok, note: "Claude Code, the agent behind every Parlay action.", icon: "sparkle", brand: "claude.svg",
			actions: claude.ok
				? [{ label: "Log out", msg: { agent: "claude", args: ["auth", "logout"] }, quiet: true }]
				: [{ label: claude.installed ? "Log in" : "Install Claude Code", msg: claude.installed ? { agent: "claude", args: ["auth", "login"] } : { shell: "npm install -g @anthropic-ai/claude-code" } }],
		},
		{
			title: "GPT", status: codex.status, ok: codex.ok, icon: "hubot", brand: "openai.svg", note: openaiKey ? "OpenAI API key set: concept drafts and texture painting." : "OpenAI API key not set: concept drafts and texture painting need one.",
			actions: [
				codex.ok ? { label: "Log out of Codex", msg: { agent: "gpt", args: ["logout"] }, quiet: true }
					: { label: codex.installed ? "Log in to Codex" : "Install Codex", msg: codex.installed ? { agent: "gpt", args: ["login"] } : { shell: "npm install -g @openai/codex" } },
				...keyActions("parlay.openaiApiKey", "parlay.openai.setKey", openaiKey).map((a) => ({ ...a, label: a.label.replace("key", "OpenAI key") })),
			],
		},
	];
}

// a CLI's own answer about who is logged in; "installed" false when the command is not on PATH
function cli(cmd: string, args: string[]): Promise<{ code: number; out: string; installed: boolean }> {
	return new Promise((res) => execFile(cmd, args, { shell: process.platform === "win32", windowsHide: true, timeout: 15000 }, (e, out, err) => {
		const text = String(out ?? "") + String(err ?? "");
		const code = (e as { code?: number } | null)?.code ?? 0;
		res({ code: typeof code === "number" ? code : 1, out: text, installed: !/not recognized|not found|ENOENT/i.test(text) || code === 0 });
	}));
}

async function claudeStatus(cmd: string): Promise<{ ok: boolean; status: string; installed: boolean }> {
	const r = await cli(cmd, ["auth", "status"]);
	if (!r.installed) return { ok: false, status: "Claude Code is not installed", installed: false };
	try {
		const j = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
		if (j.loggedIn) return { ok: true, installed: true, status: [j.email ?? "Logged in", j.subscriptionType ? `${j.subscriptionType} plan` : j.authMethod].filter(Boolean).join(" · ") };
		return { ok: false, installed: true, status: "Not logged in" };
	} catch { return { ok: false, installed: true, status: "Not logged in" }; }
}

async function codexStatus(): Promise<{ ok: boolean; status: string; installed: boolean }> {
	const r = await cli(exe("gpt"), ["login", "status"]);
	if (!r.installed) return { ok: false, status: "Codex CLI is not installed", installed: false };
	const ok = r.code === 0 && /logged in/i.test(r.out) && !/not logged in/i.test(r.out);
	return { ok, installed: true, status: ok ? r.out.trim().split(/\r?\n/)[0].slice(0, 80) : "Not logged in" };
}

// ---- the page --------------------------------------------------------------------------------------------

function html(rows: Row[], csp: string, brand: (file: string) => string): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!));
	const nonce = Math.random().toString(36).slice(2);
	// the mark: the brand; when signed in, the avatar with the brand as a small badge; a monogram when there is no mark
	const mark = (r: Row) => {
		const b = r.brand ? `<img class="brand" src="${esc(brand(r.brand))}" alt="">` : "";
		if (r.avatar) return `<div class="av-wrap"><img class="av" src="${esc(r.avatar)}" alt="">${b ? `<span class="badge">${b}</span>` : ""}</div>`;
		return b ? `<div class="av brandbox">${b}</div>` : `<div class="av mono">${esc(r.title)}</div>`;
	};
	const row = (r: Row) => `<section class="${r.ok ? "ok" : ""}">
	${mark(r)}
	<div class="body"><h2>${esc(r.title)}</h2><div class="status">${esc(r.status)}</div>${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</div>
	<div class="actions">${r.actions.map((a) => `<button class="${a.quiet ? "quiet" : ""}" data-msg='${esc(JSON.stringify(a.msg))}'>${esc(a.label)}</button>`).join("")}</div>
</section>`;
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: ${csp}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;padding:28px 32px;font:13px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:transparent;max-width:720px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
p.lead{margin:0 0 22px;color:var(--vscode-descriptionForeground)}
section{display:flex;align-items:center;gap:16px;padding:14px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
section:last-of-type{border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
.av{width:40px;height:40px;border-radius:50%;flex:0 0 40px;object-fit:cover;background:var(--vscode-toolbar-hoverBackground)}
.av.mono{display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;letter-spacing:.02em;color:var(--vscode-descriptionForeground)}
.av.brandbox{display:flex;align-items:center;justify-content:center;border-radius:12px}
.av.brandbox img.brand{width:22px;height:22px;object-fit:contain}
.av-wrap{position:relative;flex:0 0 40px;width:40px;height:40px}
.badge{position:absolute;right:-5px;bottom:-5px;width:20px;height:20px;border-radius:50%;background:var(--vscode-editor-background,#1e1e1e);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px var(--vscode-widget-border,rgba(128,128,128,.35))}
.badge img.brand{width:12px;height:12px;object-fit:contain}
section.ok .av.mono{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
.body{flex:1 1 auto;min-width:0}
h2{font-size:14px;font-weight:600;margin:0}
.status{color:var(--vscode-descriptionForeground)}
section.ok .status{color:var(--vscode-foreground)}
.note{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:2px}
.actions{display:flex;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end;max-width:260px}
button{padding:5px 14px;border:0;border-radius:999px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit;font-size:12px}
button.quiet{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button:hover{filter:brightness(1.1)}
</style></head><body>
<h1>Accounts</h1><p class="lead">Who Parlay is signed in as, and the keys it holds. Keys and tokens live in the OS keychain.</p>
${rows.map(row).join("\n")}
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.querySelectorAll("button[data-msg]").forEach(b=>b.onclick=()=>{b.disabled=true;vs.postMessage(JSON.parse(b.dataset.msg))});</script>
</body></html>`;
}
