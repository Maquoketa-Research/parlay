// Parlay: the agents tab. One terminal in the Terminal view (right sidebar) runs Claude Code or Codex (GPT).
// The switch has the running CLI write a handoff note out of band (.parlay/handoff.md), ends it, and starts
// the other CLI on that note. The active agent and both session ids are remembered per workspace, so
// switching back resumes the earlier session instead of starting cold.
import * as vscode from "vscode";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Agent, CONTINUE_PROMPT, NAMES, SUMMARY_PROMPT, claudeTranscript, codexTranscript, other, renderHandoff, renderTurns, textTurns } from "./handoff";

interface Session { id: string; file?: string }                                    // file: Codex's rollout, once found
interface State { agent: Agent; claude?: Session; gpt?: Session; since?: number }   // since: when the running CLI started
const DEFAULT_ARGS: Record<Agent, string> = { claude: "--permission-mode acceptEdits", gpt: "-a on-request -s workspace-write" };
const ICON: Record<Agent, string> = { claude: "sparkle", gpt: "hubot" };
const COLOR: Record<Agent, string> = { claude: "terminal.ansiYellow", gpt: "terminal.ansiGreen" };

let ctx: vscode.ExtensionContext;
let term: vscode.Terminal | undefined;   // the agent terminal: the newest live one named Claude or GPT
let status: vscode.StatusBarItem;

const isAgent = (t: vscode.Terminal) => t.name === NAMES.claude || t.name === NAMES.gpt;
const agentOf = (t: vscode.Terminal): Agent => t.name === NAMES.gpt ? "gpt" : "claude";
// the model in use is whatever the live tab says, not what was saved: the saved state is for resuming
const active = (): Agent => term ? agentOf(term) : state().agent;

export function registerAgents(c: vscode.ExtensionContext) {
	ctx = c;
	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	status.command = "parlay.agents.switch";
	ctx.subscriptions.push(
		status,
		vscode.commands.registerCommand("parlay.agents.open", () => term ? term.show(true) : void use(state().agent)),
		vscode.commands.registerCommand("parlay.agents.useClaude", () => use("claude")),
		vscode.commands.registerCommand("parlay.agents.useGpt", () => use("gpt")),
		vscode.commands.registerCommand("parlay.agents.switch", () => use(other(active()))),
		vscode.window.onDidCloseTerminal((t) => { if (t === term) { term = vscode.window.terminals.filter(isAgent).filter((x) => x !== t).pop(); refresh(); } }),
		// "Claude" is the default terminal profile (extension.ts sets it): the >_ in the sidebar, Ctrl+`, and the +
		// button all start Claude, and whatever they start becomes the agent terminal
		vscode.window.registerTerminalProfileProvider("parlay.claude", {
			provideTerminalProfile: async () => { const s = state(); const o = options(s, "claude"); await ctx.workspaceState.update("agents", s); return new vscode.TerminalProfile(o); },
		}),
		vscode.window.onDidOpenTerminal((t) => { if (isAgent(t)) { term = t; refresh(); } }),
	);
	void adoptSurvivors();
	refresh();
}

// After a window reload, agent tabs come back with their history. One whose CLI is still alive (persistent
// sessions) is adopted; a dead one is only a transcript and would catch the switch instead of the live tab,
// so it goes.
async function adoptSurvivors() {
	for (const t of vscode.window.terminals.filter(isAgent)) {
		if (await t.processId) term = t; else t.dispose();
	}
	// The Terminal view comes back before this extension activates, and at that moment the Claude profile is not
	// registered yet, so its first tab is a plain shell nobody asked for. One lone shell and no agent: it becomes
	// the agent tab.
	const all = vscode.window.terminals;
	if (!term && all.length === 1 && /powershell|pwsh|cmd|bash/i.test(all[0].name) && cwd()) {
		all[0].dispose();
		await use(state().agent, undefined, false);
	}
	refresh();
}

// A Claude skill line (`/parlay-fix …`) for the agent terminal. Claude running: typed into it. Nothing
// running: Claude starts on it. GPT running: the skills are Claude's, so the tab swaps to Claude cold (no note;
// the skill names its own target) and GPT's session stays resumable through the switch.
export function send(line: string) {
	if (term && active() === "gpt") void vscode.window.showInformationMessage("Parlay skills run in Claude: the agent terminal is switching to Claude. GPT's session is kept; switch back to resume it.");
	void use("claude", line, false);
}

const state = (): State => ctx.workspaceState.get<State>("agents") ?? { agent: "claude" };
const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const cfg = (k: string, d: string) => vscode.workspace.getConfiguration("parlay").get<string>(k, d);
const argsOf = (a: Agent) => cfg(a === "claude" ? "claudeArgs" : "codexArgs", DEFAULT_ARGS[a]).split(/\s+/).filter(Boolean);

function refresh() {
	const a = active();
	void vscode.commands.executeCommand("setContext", "parlay.agent", a);
	void vscode.commands.executeCommand("setContext", "parlay.agentRunning", !!term);   // Open agent vs Swap model on the terminal title
	status.text = `$(${ICON[a]}) ${NAMES[a]}`;
	status.tooltip = `Agent terminal: ${NAMES[a]}${term ? "" : " (not running)"}. Click to swap to ${NAMES[other(a)]} (Ctrl+Alt+S).`;
	status.show();
}

// Continue in `a`. A running CLI with a conversation writes the handoff note first (one turn, out of band),
// is ended, and `a` starts on the note, resuming its own earlier session when there is one. A `prompt` is
// typed in as the first message instead; `handoff` false switches cold.
async function use(a: Agent, prompt?: string, handoff = true) {
	const ws = cwd();
	if (!ws) { void vscode.window.showInformationMessage("Open a folder first: the agent runs in the workspace."); return; }
	const s = state(), running = term;
	if (running && s.agent === a) { running.show(true); if (prompt) type(running, prompt); return; }
	if (running) {
		const from = s.agent, sess = await session(s);
		if (sess) s[from] = sess;   // so switching back resumes it
		const note = handoff ? sess : undefined;   // the session that writes the note
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: note ? `Summarising the ${NAMES[from]} conversation for ${NAMES[a]}…` : `Ending ${NAMES[from]}…` }, async () => {
			await end(running, from);
			if (!note) return;
			const body = await summarise(from, note, ws);
			if (body) { writeHandoff(from, note, body, ws); prompt ??= CONTINUE_PROMPT; }
		});
	}
	await start(s, a, prompt);
}

// The running agent's session. Claude's id is one Parlay chose, but /clear inside Claude makes a new one, so
// the live-session record Claude keeps by pid (~/.claude/sessions/<pid>.json) wins. Codex names its own: the
// newest rollout for this folder written since launch (so /new is followed too), else the remembered one.
async function session(s: State): Promise<Session | undefined> {
	if (s.agent === "gpt") return codexTranscript(cwd()!, s.since ?? 0) ?? s.gpt;
	try {
		const live = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "sessions", `${await term?.processId}.json`), "utf8"));
		if (typeof live.sessionId === "string") return { id: live.sessionId };
	} catch { /* no record: the id we launched with */ }
	return s.claude;
}

// Start `a` in the agent terminal.
async function start(s: State, a: Agent, prompt?: string) {
	term = vscode.window.createTerminal(options(s, a, prompt));
	term.show(true);
	await ctx.workspaceState.update("agents", s);
	refresh();
}

// The terminal for `a`, resuming its remembered session when the transcript is still there; `s` is marked as
// running `a` from now (the caller persists it). The CLI is the terminal's process, no shell in between:
// nothing to quote, and the terminal closing is the exact signal that the CLI has ended. (When the CLI exits
// on its own the tab goes with it; Ctrl+Alt+A or the >_ brings it back.)
function options(s: State, a: Agent, prompt?: string): vscode.TerminalOptions {
	const ws = cwd(), old = s[a], args = argsOf(a), tail = prompt ? [prompt] : [];
	// No CLI on this machine: a terminal that cannot start is a terminal that never opens (the tester saw exactly
	// that), so open a plain PowerShell that says what is missing and offer the official installer.
	if (!onPath(exe(a))) {
		const name = NAMES[a], install = a === "claude" ? "irm https://claude.ai/install.ps1 | iex" : "npm install -g @openai/codex";
		void vscode.window.showWarningMessage(`${name} is not installed on this machine, so the agent terminal opened as PowerShell. Install it?`, `Install ${name}`).then((pick) => {
			if (pick && term) type(term, install);
		});
		return { name, cwd: ws, shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoExit", "-Command", `Write-Host '${name} is not installed. Install it with:  ${install}' -ForegroundColor Yellow`], iconPath: new vscode.ThemeIcon(ICON[a]), color: new vscode.ThemeColor(COLOR[a]) };
	}
	const resume = !!old && !!(a === "claude" ? ws && claudeTranscript(ws, old.id) : old.file && fs.existsSync(old.file));
	let shellArgs: string[];
	if (a === "claude") {
		const id = resume ? old!.id : crypto.randomUUID();
		const brief = writeBrief();
		shellArgs = [...args, ...(brief ? ["--append-system-prompt-file", brief] : []), resume ? "--resume" : "--session-id", id, ...tail];
		s.claude = { id };
	} else {
		// the same brief for GPT, as Codex's developer instructions (a TOML string on -c: one argument, no raw newlines)
		const brief = ["-c", `developer_instructions=${JSON.stringify(BRIEF_CORE)}`];
		shellArgs = resume ? ["resume", ...brief, ...args, old!.id, ...tail] : [...brief, ...args, ...tail];
	}
	s.agent = a; s.since = Date.now();
	return { name: NAMES[a], cwd: ws, shellPath: exe(a), shellArgs, iconPath: new vscode.ThemeIcon(ICON[a]), color: new vscode.ThemeColor(COLOR[a]) };
}

// Ask the CLI to quit (both TUIs take a slash command) and give it a few seconds before pulling the plug.
function end(t: vscode.Terminal, a: Agent) {
	return new Promise<void>((res) => {
		const done = () => { sub.dispose(); clearTimeout(timer); res(); };
		const sub = vscode.window.onDidCloseTerminal((x) => { if (x === t) done(); });
		const timer = setTimeout(() => { t.dispose(); done(); }, 6000);
		type(t, a === "claude" ? "/exit" : "/quit", 2);
	});
}

// The system prompt Parlay appends to every Claude it starts: what this folder is (a live Script Sync mirror),
// how to see and test the game (the Studio MCP), the house rules, the skills, and the two modes the user keeps
// on. Ponytail full: its plugin's SessionStart hook reads ~/.claude/.ponytail-active, so that file is set to
// "full" when the plugin is installed. Caveman lite: the skill text is inlined with the level pinned (it has
// no persistence of its own). Written fresh on each launch into Parlay's global storage.
function writeBrief(): string | undefined {
	try {
		const claude = path.join(os.homedir(), ".claude");
		const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
		const parts = [BRIEF];
		const caveman = read(path.join(claude, "skills", "caveman", "SKILL.md")).replace(/^---[\s\S]*?---\s*/, "");
		if (caveman) parts.push("# Caveman mode is ON at level lite for this whole session\n\nParlay turned it on for the user, as if `/caveman lite` had been run. The level is lite, not the skill's default.\n\n" + caveman);
		if (fs.existsSync(path.join(claude, "plugins", "cache", "ponytail"))) {
			const active = path.join(claude, ".ponytail-active");
			if (read(active).trim() !== "full") fs.writeFileSync(active, "full");
		}
		const dir = ctx.globalStorageUri.fsPath, file = path.join(dir, "claude-brief.md");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, parts.join("\n\n"));
		return file;
	} catch { return undefined; }
}

const BRIEF_CORE = `# Parlay

You are running inside Parlay, Maquoketa Research's editor for Roblox game development (a VS Code fork). The user is a game developer working on a live Roblox place.

## This folder is a live mirror of the place
- It is Roblox Studio's Script Sync folder. Each top-level folder is a service (ReplicatedStorage, ServerScriptService, ReplicatedFirst, ServerStorage, StarterGui, StarterPlayerScripts, StarterCharacterScripts); folders below are Folders, or scripts with children.
- Files: \`Name.server.luau\` is a Script, \`Name.client.luau\` a LocalScript, \`Name.luau\` a ModuleScript; \`init.*.luau\` makes its folder that script. Non-script instances (Parts, RemoteEvents, Folders holding none) are not on disk.
- Saving a file changes the running place in Studio within a second. Deleting, moving or renaming a file does the same to the instance: never do that unless asked. Workspace scripts are not synced here.
- \`sourcemap.json\` is generated from this folder for luau-lsp; do not edit it.

## How to see and test the game
- The \`Roblox_Studio\` MCP tools talk to the open Studio: \`list_roblox_studios\` first, then \`search_game_tree\` / \`inspect_instance\` for what is not on disk, \`execute_luau\` to read or set up state, \`start_stop_play\` and \`get_console_output\` to run and read errors, \`screen_capture\` to look. Verify in Studio rather than guess.
- One MCP client holds Studio at a time. If the tools say Studio is unreachable, say so once and work from the files.

## Luau house rules
- Keep \`--!strict\` where a file has it; typed signatures; no globals.
- Server authority: validate every RemoteEvent and RemoteFunction argument on the server; never trust the client for money, inventory or position.
- DataStore calls in pcall with retry, never per frame.
- Minimal, local changes in the file's existing style; no new frameworks.`;

// Claude also has the Parlay skills; GPT gets the core brief alone (JSON.stringify makes a valid TOML basic string)
const BRIEF = BRIEF_CORE + `

## Parlay skills
/parlay-explain, /parlay-fix, /parlay-validate, /parlay-pcall, /parlay-extract, /parlay-test, /parlay-ab, /parlay-insert-asset, /parlay-match-assets. Parlay types these in from the editor; run them as written.`;

// Typing into a running CLI. sendText puts the Enter in the same write as the text, and the TUIs read that
// burst as a paste and keep the newline inside it; Enter on its own a beat later submits. A slash command
// with nothing after it has its autocomplete open, where the first Enter picks the entry and the second sends.
function type(t: vscode.Terminal, line: string, enters = 1) {
	t.sendText(line, false);
	for (let i = 1; i <= enters; i++) setTimeout(() => t.sendText("", true), 250 * i);
}

// One turn out of band: the departing CLI writes the note itself. `claude -p --resume <id> …` prints it;
// `codex exec resume <id> … -o <file>` writes its last message to a file (both verified live, Sep 15 2026).
// If that fails, the last text turns of the transcript stand in.
async function summarise(a: Agent, sess: Session, ws: string): Promise<string | undefined> {
	const file = a === "claude" ? claudeTranscript(ws, sess.id) : sess.file;
	if (!file) return;
	const turns = textTurns(fs.readFileSync(file, "utf8"));
	if (!turns.some((t) => t.role === "assistant")) return;   // nothing happened yet: switch cold
	try {
		let note: string;
		if (a === "claude") note = await run(exe(a), ["-p", "--resume", sess.id, SUMMARY_PROMPT], ws);
		else {
			const out = path.join(os.tmpdir(), `parlay-handoff-${sess.id}.md`);
			await run(exe(a), ["exec", "resume", "--skip-git-repo-check", sess.id, SUMMARY_PROMPT, "-o", out], ws);
			note = fs.readFileSync(out, "utf8");
			fs.rmSync(out, { force: true });
		}
		if (!note.trim()) throw new Error("empty note");
		return note;
	} catch (e) {
		void vscode.window.showWarningMessage(`Parlay: ${NAMES[a]} could not write the handoff note (${e}). The last turns of the transcript are handed over instead.`);
		return renderTurns(turns);
	}
}

// Stdin closed at once: codex exec reads a piped stdin to EOF before it starts.
function run(file: string, args: string[], cwd: string) {
	return new Promise<string>((res, rej) => {
		const p = execFile(file, args, { cwd, windowsHide: true, maxBuffer: 8 << 20, timeout: 180_000 },
			(e, out, err) => e ? rej(new Error(String(err || e).trim().slice(0, 300))) : res(out));
		p.stdin?.end();
	});
}

function writeHandoff(from: Agent, sess: Session, body: string, ws: string) {
	fs.mkdirSync(path.join(ws, ".parlay"), { recursive: true });
	fs.writeFileSync(path.join(ws, ".parlay", "handoff.md"), renderHandoff({ agent: from, id: sess.id, cwd: ws, mode: argsOf(from).join(" ") }, body));
	// Kept out of git without touching the repo's own .gitignore. ponytail: a plain .git folder only; a worktree's
	// .git file is skipped (its exclude file lives in the common dir).
	try {
		if (!fs.statSync(path.join(ws, ".git")).isDirectory()) return;
		const info = path.join(ws, ".git", "info"), ex = path.join(info, "exclude");
		fs.mkdirSync(info, { recursive: true });
		const have = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
		if (!/^\.parlay\/?\s*$/m.test(have)) fs.appendFileSync(ex, `${!have || have.endsWith("\n") ? "" : "\n"}.parlay/\n`);
	} catch { /* not a git repo */ }
}

// Which executable: parlay.claudeCommand as is. codex.exe is on no PATH here (the Codex desktop app keeps it under
// %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\), so parlay.codexCommand wins when it resolves, else the newest one the app installed.
// is `cmd` runnable as a terminal process: an absolute path that exists, or a name found on PATH
function onPath(cmd: string): boolean {
	if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	return dirs.some((d) => ["", ".exe", ".cmd"].some((x) => fs.existsSync(path.join(d, cmd + x))));
}
export const claudeInstalled = () => onPath(cfg("claudeCommand", "claude"));

function exe(a: Agent): string {
	if (a === "claude") return cfg("claudeCommand", "claude");
	const set = cfg("codexCommand", "codex");
	if (onPath(set)) return set;
	const bin = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
	let best: { file: string; mtime: number } | undefined;
	try {
		for (const d of fs.readdirSync(bin)) {
			const file = path.join(bin, d, "codex.exe");
			if (!fs.existsSync(file)) continue;
			const mtime = fs.statSync(file).mtimeMs;
			if (!best || mtime > best.mtime) best = { file, mtime };
		}
	} catch { /* no desktop app */ }
	return best?.file ?? set;
}
