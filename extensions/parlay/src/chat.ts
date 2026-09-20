// Parlay: the Chat tab. One conversation in the right sidebar, answered by Claude Code or Codex (GPT) run
// headless, switchable mid-conversation. The transcript Parlay keeps is the source of truth: the agent that
// takes over gets the turns it did not see as the preface of the next message, and an agent switched back to
// resumes its own session. Claude is one long-lived `claude -p` process per window (stream-json both ways);
// GPT is one `codex exec --json` process per turn, `exec resume <thread>` after the first. Both run in the
// workspace folder with the Parlay brief (agents.ts). The agent terminal (agents.ts) stays as it is; this is
// the chat alternative. Event shapes: chatEvents.ts.
import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { agentBrief, argsOf, exe, onPath, writeBrief } from "./agents";
import { Entry, applyClaude, applyCodex } from "./chatEvents";
import { Agent, Turn, claudeTranscript, other, renderTurns } from "./handoff";
import { agentStatus, AgentStatus } from "./agentStatus";
import { agentOptions, configureAgent, optionArgs } from "./agentOptions";
import { log } from "./log";

// Saved per workspace: <globalStorage>/chat/<hash>.json. `handoff` is set by a switch and spent by the next send.
interface Store { id?: string; agent: Agent; entries: Entry[]; claude?: string; gpt?: string; handoff?: boolean }
interface Turning { agent: Agent; proc: ChildProcess; stopped?: boolean; started: boolean; err: string }
const NAMES: Record<Agent, string> = { claude: "Claude", gpt: "Codex" };

const INSTALL: Record<Agent, string> = {
	claude: process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash",
	gpt: "npm install -g @openai/codex",
};

export function registerChat(ctx: vscode.ExtensionContext) {
	const chat = new ChatView(ctx);
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider("parlay.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand("parlay.chat.open", () => vscode.commands.executeCommand("parlay.chat.focus")),
		vscode.commands.registerCommand("parlay.chat.new", () => chat.fresh()),
		vscode.commands.registerCommand("parlay.chat.history", () => chat.history()),
		vscode.commands.registerCommand("parlay.chat.useClaude", () => chat.use("claude")),
		vscode.commands.registerCommand("parlay.chat.useGpt", () => chat.use("gpt")),
		{ dispose: () => chat.dispose() },
	);
	return (text: string, context?: Entry["context"], instructions?: string) => chat.sendAction(text, context, instructions);
}

class ChatView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private store: Store;
	private claudeOptions?: string;
	private claude?: ChildProcess;   // the long-lived Claude process, once started
	private turn?: Turning;          // the turn running now
	private pushTimer?: NodeJS.Timeout;
	private attachment?: Entry["context"];
	private statuses: Partial<Record<Agent, AgentStatus>> = {};
	private checking?: Promise<void>;
	private disposed = false;

	constructor(private ctx: vscode.ExtensionContext) {
		this.store = this.load();
		this.save(); // Give existing conversations a stable identity before the view keeps a draft.
		this.context();
		ctx.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.push()));
	}

	dispose() { this.disposed = true; if (this.pushTimer) clearTimeout(this.pushTimer); this.claude?.kill(); this.turn?.proc.kill(); }

	// ---- the view ----------------------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		const w = view.webview, uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
		w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src ${w.cspSource}; font-src ${w.cspSource}; img-src ${w.cspSource}">
<link rel="stylesheet" href="${uri("chat.css")}"></head><body>
<header><span class="workspace-mark" aria-hidden="true">⌘</span><span id="workspace">Your workspace</span><button id="history" class="icon-button" title="Conversation history" aria-label="Conversation history"><svg viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/></svg></button><button id="new" class="icon-button" title="New chat" aria-label="New chat"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></header>
<main id="log" aria-label="Conversation"></main>
<button id="latest" class="latest" hidden>↓ Latest messages</button>
<footer><div class="composer"><div id="attachment" hidden></div><textarea id="in" aria-label="Message" rows="1" placeholder="What would you like to build?"></textarea><div class="composer-actions"><button id="attach" class="icon-button" title="Attach selection or current file" aria-label="Attach selection or current file"><svg viewBox="0 0 24 24"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M6 14l8-8"/></svg></button><div class="pick" role="group" aria-label="Choose agent"><button data-a="claude" aria-pressed="false"><img src="${uri("brands/claude.svg")}" alt="">Claude</button><button data-a="gpt" aria-pressed="false"><img class="openai-mark" src="${uri("brands/openai.svg")}" alt="">Codex</button></div><span class="spacer"></span><button id="stop" class="send-button stop" aria-label="Stop response" title="Stop response" hidden><svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg></button><button id="go" class="send-button" aria-label="Send message" title="Send message" disabled><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></div></div><div class="composer-meta"><div class="agent-options" aria-label="Agent settings" title="Caveman lite · Ponytail full are always included"><button id="model" title="Choose model">Model: Default</button><button id="effort" title="Choose thinking effort">Thinking: Default</button><button id="fast" aria-pressed="false" title="Fast mode uses additional quota when supported">Fast: Off</button></div><span class="hint">⇧ Enter for a new line</span></div><div id="agent-status" class="composer-meta" hidden><span id="status" role="status">Checking agent…</span><button id="signin" class="text-button" hidden>Sign in</button><button id="refresh" class="text-button" title="Refresh agent status" aria-label="Refresh agent status">↻</button></div></footer>
<script src="${uri("chat.js")}"></script></body></html>`;
		w.onDidReceiveMessage((m) => {
			if (m?.type === "send" && typeof m.text === "string") void this.send(m.text).then(accepted => w.postMessage({ type: "sendResult", accepted })).catch(error => {
				log.warn(`chat: could not send message: ${error}`);
				void w.postMessage({ type: "sendResult", accepted: false });
			});
			else if (m?.type === "stop") this.stop();
			else if (m?.type === "use" && (m.agent === "claude" || m.agent === "gpt")) this.use(m.agent);
			else if (m?.type === "option" && ["model", "effort", "fast"].includes(m.field)) void this.configure(m.field);
			else if (m?.type === "ready") this.push();
			else if (m?.type === "new") this.fresh();
			else if (m?.type === "history") void this.history();
			else if (m?.type === "attach") this.attach();
			else if (m?.type === "removeAttachment") { this.attachment = undefined; this.push(); }
			else if (m?.type === "refresh") void this.refreshStatus();
			else if (m?.type === "signin") this.signIn();
			else if (m?.type === "openFolder") void vscode.commands.executeCommand("workbench.action.files.openFolder");
			else if (m?.type === "copy" && typeof m.text === "string" && m.text.length <= 1_000_000) void vscode.env.clipboard.writeText(m.text);
		});
		view.onDidChangeVisibility(() => { if (view.visible) { this.push(); void this.refreshStatus(); } });
		view.onDidDispose(() => { this.view = undefined; });
		void this.refreshStatus();
	}

	// The whole state to the page, coalesced: streaming deltas arrive many times a second.
	private push() {
		if (this.pushTimer || this.disposed) return;
		this.pushTimer = setTimeout(() => {
			this.pushTimer = undefined;
			void this.view?.webview.postMessage({ type: "state", entries: this.store.entries, agent: this.store.agent, busy: !!this.turn, names: NAMES,
				conversationId: this.store.id, workspace: vscode.workspace.workspaceFolders?.[0]?.name, trusted: vscode.workspace.isTrusted, statuses: this.statuses, options: agentOptions(this.store.agent), attachment: this.attachment?.label });
		}, 40);
	}

	private context() { void vscode.commands.executeCommand("setContext", "parlay.chat.agent", this.store.agent); }
	private say(text: string) { this.store.entries.push({ kind: "system", text, at: Date.now() }); this.push(); }

	private refreshStatus(): Promise<void> {
		if (this.checking) return this.checking;
		return this.checking = Promise.all([agentStatus(exe("claude"), "claude"), agentStatus(exe("gpt"), "gpt")]).then(([claude, gpt]) => {
			this.statuses = { claude, gpt }; this.push();
		}).finally(() => { this.checking = undefined; });
	}

	private async configure(field: "model" | "effort" | "fast") {
		if (this.turn) return;
		if (!await configureAgent(this.store.agent, field)) return;
		if (this.claude) { const old = this.claude; this.claude = undefined; old.kill(); }
		this.push();
	}

	private signIn() {
		const agent = this.store.agent;
		if (!onPath(exe(agent))) { void vscode.window.showInformationMessage(`Install ${NAMES[agent]} first: ${INSTALL[agent]}`); return; }
		const terminal = vscode.window.createTerminal({ name: `${NAMES[agent]} sign-in`, shellPath: exe(agent), shellArgs: agent === "claude" ? ["auth", "login"] : ["login"] });
		terminal.show();
		const closed = vscode.window.onDidCloseTerminal(t => { if (t === terminal) { closed.dispose(); void this.refreshStatus(); } });
		this.ctx.subscriptions.push(closed);
	}

	private attach() {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== "file") { void vscode.window.showInformationMessage("Open a file or select some code to attach it."); return; }
		const selected = !editor.selection.isEmpty;
		const text = editor.document.getText(selected ? editor.selection : undefined);
		if (text.length > 20000) { void vscode.window.showInformationMessage("Select a smaller section to attach (up to 20,000 characters)."); return; }
		const name = vscode.workspace.asRelativePath(editor.document.uri);
		const label = selected ? `${name}:${editor.selection.start.line + 1}–${editor.selection.end.line + 1}` : name;
		this.attachment = { label, text }; this.push();
	}

	// ---- the conversation --------------------------------------------------------------------------

	// Continue in `a`. The transcript stays; `a` is told what it missed with the next message.
	use(a: Agent) {
		if (a === this.store.agent) { void vscode.commands.executeCommand("parlay.chat.focus"); return; }
		if (this.turn) { void vscode.window.showInformationMessage(`${NAMES[this.turn.agent]} is still answering. Stop it or wait, then switch.`); return; }
		this.store.agent = a;
		this.store.handoff = this.missed(a).length > 0;
		if (this.store.entries.some(entry => entry.kind === "user")) this.say(`Continuing in ${NAMES[a]}`);
		else this.push();
		this.save(); this.context();
		void vscode.commands.executeCommand("parlay.chat.focus");
	}

	// A fresh conversation: new sessions on both sides, the same agent.
	fresh() {
		if (!this.archive()) return;
		this.turn?.proc.kill(); this.turn = undefined;   // (not stop(): nothing to report into the new transcript)
		this.claude?.kill(); this.claude = undefined;
		this.store = { id: crypto.randomUUID(), agent: this.store.agent, entries: [] };
		this.attachment = undefined;
		this.save(); this.push();
	}

	async history() {
		if (this.turn) { void vscode.window.showInformationMessage("Stop the current response before opening another conversation."); return; }
		if (!this.archive()) return;
		const dir = this.file().replace(/\.json$/, "");
		const items: { label: string; description: string; file: string; at: number }[] = [];
		try {
			for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".json"))) {
				try {
					const file = path.join(dir, name), saved = readStore(file);
					const first = saved.entries.find(e => e.kind === "user"), at = saved.entries.at(-1)?.at ?? 0;
					if (first) items.push({ label: first.text.replace(/\s+/g, " ").slice(0, 100), description: `${NAMES[saved.agent] ?? "Chat"} · ${new Date(at).toLocaleString()}`, file, at });
				} catch { /* Ignore unreadable history entries. */ }
			}
		} catch { /* No saved conversations yet. */ }
		if (!items.length) { void vscode.window.showInformationMessage("Your conversations will appear here after your first message."); return; }
		const picked = await vscode.window.showQuickPick(items.sort((a, b) => b.at - a.at), { title: "Chat history", placeHolder: "Resume a conversation in this project" });
		if (!picked || this.turn) return;
		try {
			const saved = readStore(picked.file);
			this.claude?.kill(); this.claude = undefined;
			this.store = saved;
			for (const entry of this.store.entries) entry.open = false;
			this.attachment = undefined;
			this.save(); this.context(); this.push();
		} catch { void vscode.window.showErrorMessage("This conversation could not be opened."); }
	}

	private archive(): boolean {
		if (!this.store.entries.some(entry => entry.kind === "user")) return true;
		const dir = this.file().replace(/\.json$/, "");
		try { fs.mkdirSync(dir, { recursive: true }); writeStore(path.join(dir, `${this.store.id}.json`), this.store); return true; }
		catch (error) {
			log.warn(`chat: could not archive conversation: ${error}`);
			void vscode.window.showErrorMessage("Could not save this conversation to history. Your current chat is still open.");
			return false;
		}
	}

	async sendAction(text: string, context?: Entry["context"], instructions?: string) {
		await vscode.commands.executeCommand("parlay.chat.focus");
		if (this.turn) { void vscode.window.showInformationMessage("Chat is still answering. Stop it or wait, then run the action again."); return false; }
		return this.send(text, context, instructions);
	}

	async send(text: string, actionContext?: Entry["context"], instructions?: string) {
		const a = this.store.agent, ws = cwd();
		text = text.trim();
		if (this.turn || !text) return false;
		if (!ws) { this.say("Open a project folder to start a conversation."); return false; }
		if (!vscode.workspace.isTrusted) { this.say("This workspace is in Restricted Mode. Manage Workspace Trust before running an agent."); return false; }
		if (!onPath(exe(a))) { this.say(`${NAMES[a]} is not installed on this machine. Install it, then send again:  ${INSTALL[a]}`); return false; }
		let prompt = text;
		if (this.store.handoff) {   // once: the turns this agent did not see, text only, the last 20 (renderTurns caps and cuts)
			const turns = this.missed(a);
			if (turns.length) prompt = `You are continuing a conversation the user was having with ${NAMES[other(a)]} in this same chat. These are the turns you did not see (\"Assistant\" is ${NAMES[other(a)]}). Continue from them; do not repeat them.\n\n${renderTurns(turns)}\n\n---\n\n${text}`;
			this.store.handoff = false;
		}
		const context = actionContext ?? this.attachment;
		if (instructions) prompt += `\n\nAction instructions:\n${instructions}`;
		if (context) prompt += `\n\nAttached code from ${context.label}:\n\n${context.text}`;
		this.store.entries.push({ kind: "user", text, context, at: Date.now() });
		if (!actionContext) this.attachment = undefined;
		this.save(); this.push();
		try {
			if (a === "claude") this.sendClaude(ws, prompt); else this.sendGpt(ws, prompt);
		} catch (e) { this.turn = undefined; this.say(`${NAMES[a]} could not start: ${e}`); }
		return true;
	}

	// The user and assistant turns since `a` last spoke (all of them for an agent new to this chat).
	private missed(a: Agent): Turn[] {
		const es = this.store.entries, from = es.map((e) => e.agent).lastIndexOf(a) + 1;
		return es.slice(from).filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => ({ role: e.kind as Turn["role"], text: e.text + (e.context ? `\n\nAttached code from ${e.context.label}:\n${e.context.text}` : "") }));
	}

	// Stop the turn: Claude takes an interrupt on stdin and stays up (verified: control_response, then a result
	// with subtype error_during_execution); Codex is one process per turn, so it is ended and the thread resumes next time.
	stop() {
		const t = this.turn;
		if (!t) return;
		t.stopped = true;
		if (t.agent === "claude" && this.claude) {
			this.claude.stdin?.write(JSON.stringify({ type: "control_request", request_id: `stop-${Date.now()}`, request: { subtype: "interrupt" } }) + "\n");
			setTimeout(() => { if (this.turn === t) { log.warn("chat: Claude did not stop on interrupt; killing it"); this.claude?.kill(); } }, 8000);
		} else t.proc.kill();
	}

	// ---- Claude: one process, messages on stdin ------------------------------------------------------

	private sendClaude(ws: string, prompt: string) {
		const options = JSON.stringify(agentOptions("claude"));
		if (this.claude && this.claudeOptions !== options) { const old = this.claude; this.claude = undefined; old.kill(); }
		if (!this.claude) this.startClaude(ws);
		const p = this.claude!;
		this.turn = { agent: "claude", proc: p, started: false, err: "" };
		p.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
		this.push();
	}

	// `claude -p` with stream-json in and out, the Parlay brief appended, the permission mode from parlay.claudeArgs
	// (acceptEdits by default: edits land, anything else that would prompt is denied and Claude says so; there is
	// no one to answer a prompt in this mode). Resumes this chat's session when its transcript is still on disk.
	private startClaude(ws: string) {
		const old = this.store.claude, resume = !!old && !!claudeTranscript(ws, old);
		const id = resume ? old! : crypto.randomUUID();
		const brief = writeBrief();
		const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
			...argsOf("claude"), ...optionArgs("claude"), ...(brief ? ["--append-system-prompt-file", brief] : []), resume ? "--resume" : "--session-id", id];
		const p = spawn(exe("claude"), args, { cwd: ws, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		this.claudeOptions = JSON.stringify(agentOptions("claude"));
		this.claude = p; this.store.claude = id;
		log.info(`chat: Claude started (pid ${p.pid}, ${resume ? "resume" : "session"} ${id})`);
		lines(p, (e) => { if (this.claude === p) this.onEvent("claude", e); }, (s) => { if (this.turn?.proc === p) this.turn.err += s; log.warn(`chat: claude: ${s.trim()}`); });
		p.on("error", (e) => { this.died("claude", p, String(e)); });
		p.on("exit", (code) => {
			log.info(`chat: Claude exited (${code})`);
			this.died("claude", p, code ? `exit ${code}` : "");
		});
	}

	// ---- GPT: one codex exec per turn ------------------------------------------------------------------

	// `codex exec --json … -` with the prompt on stdin (no quoting, no command-line limit), the brief as developer
	// instructions, the workspace-write sandbox as config (`exec resume` takes no -s), and the thread resumed after
	// the first turn. Codex approves nothing in exec mode: what the sandbox refuses fails and GPT says so.
	private sendGpt(ws: string, prompt: string) {
		const thread = this.store.gpt;
		const args = ["exec", ...(thread ? ["resume"] : []), "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"workspace-write\"",
			"-c", `developer_instructions=${JSON.stringify(agentBrief())}`, ...optionArgs("gpt"), ...(thread ? [thread] : []), "-"];
		const p = spawn(exe("gpt"), args, { cwd: ws, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		this.turn = { agent: "gpt", proc: p, started: false, err: "" };
		log.info(`chat: GPT started (pid ${p.pid}${thread ? `, thread ${thread}` : ""})`);
		lines(p, (e) => { if (this.turn?.proc === p) this.onEvent("gpt", e); }, (s) => { if (this.turn?.proc === p) this.turn.err += s; log.warn(`chat: codex: ${s.trim()}`); });
		p.stdin!.end(prompt);
		p.on("error", (e) => this.died("gpt", p, String(e)));
		p.on("exit", (code) => { log.info(`chat: GPT exited (${code})`); this.died("gpt", p, code ? `exit ${code}` : ""); });
		this.push();
	}

	// ---- events ----------------------------------------------------------------------------------------

	private onEvent(a: Agent, e: any) {
		const fx = a === "claude" ? applyClaude(this.store.entries, e) : applyCodex(this.store.entries, e);
		if (fx.session) { this.store[a] = fx.session; if (this.turn?.agent === a) this.turn.started = true; }
		if (fx.done) {
			const t = this.turn;
			if (t?.agent === a) {
				this.turn = undefined;
				if (fx.error && !t.stopped) this.say(`${NAMES[a]}: ${fx.error}`);
				else if (t.stopped) this.say("Stopped");
			}
			if (fx.cost !== undefined) log.info(`chat: Claude turn done, $${fx.cost.toFixed(2)} so far this session`);
			this.save();
		}
		this.push();
	}

	// A process ended. Mid-turn that is an error the user sees (with stderr); one that never got to its first
	// event (session init / thread.started) has a session it could not resume, so the next send starts a new one.
	private died(a: Agent, p: ChildProcess, why: string) {
		if (a === "claude" && this.claude === p) this.claude = undefined;
		const t = this.turn;
		if (!t || t.proc !== p) return;
		this.turn = undefined;
		for (const e of this.store.entries) if (e.open) e.open = false;
		const err = t.err.trim().split("\n").slice(-3).join(" ").slice(0, 400);
		if (!t.started) this.store[a] = undefined;
		if (t.stopped) this.say("Stopped");
		else this.say(`${NAMES[a]} ended before answering${why ? ` (${why})` : ""}. ${err || (t.started ? "Send again to retry." : `The next message starts a new ${NAMES[a]} session.`)}`);
		this.save();
	}

	// ---- storage -----------------------------------------------------------------------------------------

	private file() {
		const ws = cwd() ?? "";
		return path.join(this.ctx.globalStorageUri.fsPath, "chat", crypto.createHash("sha1").update(ws.toLowerCase()).digest("hex").slice(0, 12) + ".json");
	}
	private load(): Store {
		try { return readStore(this.file()); } catch { /* first time or unreadable transcript */ }
		return { id: crypto.randomUUID(), agent: "claude", entries: [] };
	}
	private save() {
		try { const f = this.file(); fs.mkdirSync(path.dirname(f), { recursive: true }); writeStore(f, this.store); } catch (e) { log.warn(`chat: could not save the transcript: ${e}`); }
	}
}

function readStore(file: string): Store {
	const s = JSON.parse(fs.readFileSync(file, "utf8")) as Store;
	if (!s || !["claude", "gpt"].includes(s.agent) || !Array.isArray(s.entries) || s.entries.some(e => !e || typeof e.text !== "string")) throw new Error("Invalid conversation");
	if (typeof s.id !== "string" || !/^[0-9a-f-]{36}$/i.test(s.id)) s.id = crypto.randomUUID();
	for (const e of s.entries) e.open = false;
	return s;
}

function writeStore(file: string, store: Store) {
	const temporary = file + ".tmp";
	fs.writeFileSync(temporary, JSON.stringify(store));
	fs.renameSync(temporary, file);
}

const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// stdout as JSON lines to `onJson` (a line that is not JSON goes to the log), stderr text to `onErr`.
function lines(p: ChildProcess, onJson: (e: any) => void, onErr: (s: string) => void) {
	let buf = "";
	p.stdout!.setEncoding("utf8").on("data", (d: string) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
			if (!line) continue;
			try { onJson(JSON.parse(line)); } catch { log.warn(`chat: not JSON: ${line.slice(0, 200)}`); }
		}
	});
	p.stderr!.setEncoding("utf8").on("data", onErr);
}
