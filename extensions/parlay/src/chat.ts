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
import { BRIEF_CORE, argsOf, exe, onPath, writeBrief } from "./agents";
import { Entry, applyClaude, applyCodex } from "./chatEvents";
import { Agent, NAMES, Turn, claudeTranscript, other, renderTurns } from "./handoff";
import { log } from "./log";

// Saved per workspace: <globalStorage>/chat/<hash>.json. `handoff` is set by a switch and spent by the next send.
interface Store { agent: Agent; entries: Entry[]; claude?: string; gpt?: string; handoff?: boolean }
interface Turning { agent: Agent; proc: ChildProcess; stopped?: boolean; started: boolean; err: string }

const INSTALL: Record<Agent, string> = { claude: "irm https://claude.ai/install.ps1 | iex", gpt: "npm install -g @openai/codex" };

export function registerChat(ctx: vscode.ExtensionContext) {
	const chat = new ChatView(ctx);
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider("parlay.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand("parlay.chat.open", () => vscode.commands.executeCommand("parlay.chat.focus")),
		vscode.commands.registerCommand("parlay.chat.new", () => chat.fresh()),
		vscode.commands.registerCommand("parlay.chat.useClaude", () => chat.use("claude")),
		vscode.commands.registerCommand("parlay.chat.useGpt", () => chat.use("gpt")),
		{ dispose: () => chat.dispose() },
	);
}

class ChatView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private store: Store;
	private claude?: ChildProcess;   // the long-lived Claude process, once started
	private turn?: Turning;          // the turn running now
	private pushTimer?: NodeJS.Timeout;

	constructor(private ctx: vscode.ExtensionContext) {
		this.store = this.load();
		this.context();
	}

	dispose() { this.claude?.kill(); this.turn?.proc.kill(); }

	// ---- the view ----------------------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		const w = view.webview, uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
		w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src ${w.cspSource}; font-src ${w.cspSource}">
<link rel="stylesheet" href="${uri("chat.css")}"></head><body>
<header><div class="pick"><button data-a="claude">Claude</button><button data-a="gpt">GPT</button></div></header>
<main id="log"></main>
<footer><textarea id="in" rows="1"></textarea><button id="stop" hidden>Stop</button><button id="go">Send</button></footer>
<script src="${uri("chat.js")}"></script></body></html>`;
		w.onDidReceiveMessage((m) => {
			if (m?.type === "send" && typeof m.text === "string") void this.send(m.text);
			else if (m?.type === "stop") this.stop();
			else if (m?.type === "use" && (m.agent === "claude" || m.agent === "gpt")) this.use(m.agent);
			else if (m?.type === "ready") this.push();
		});
		view.onDidChangeVisibility(() => { if (view.visible) this.push(); });
		view.onDidDispose(() => { this.view = undefined; });
	}

	// The whole state to the page, coalesced: streaming deltas arrive many times a second.
	private push() {
		if (this.pushTimer) return;
		this.pushTimer = setTimeout(() => {
			this.pushTimer = undefined;
			void this.view?.webview.postMessage({ type: "state", entries: this.store.entries, agent: this.store.agent, busy: !!this.turn, names: NAMES });
		}, 40);
	}

	private context() { void vscode.commands.executeCommand("setContext", "parlay.chat.agent", this.store.agent); }
	private say(text: string) { this.store.entries.push({ kind: "system", text, at: Date.now() }); this.push(); }

	// ---- the conversation --------------------------------------------------------------------------

	// Continue in `a`. The transcript stays; `a` is told what it missed with the next message.
	use(a: Agent) {
		if (a === this.store.agent) { void vscode.commands.executeCommand("parlay.chat.focus"); return; }
		if (this.turn) { void vscode.window.showInformationMessage(`${NAMES[this.turn.agent]} is still answering. Stop it or wait, then switch.`); return; }
		this.store.agent = a;
		this.store.handoff = this.missed(a).length > 0;
		this.say(`Continuing in ${NAMES[a]}`);
		this.save(); this.context();
		void vscode.commands.executeCommand("parlay.chat.focus");
	}

	// A fresh conversation: new sessions on both sides, the same agent.
	fresh() {
		this.turn?.proc.kill(); this.turn = undefined;   // (not stop(): nothing to report into the new transcript)
		this.claude?.kill(); this.claude = undefined;
		this.store = { agent: this.store.agent, entries: [] };
		this.save(); this.push();
	}

	async send(text: string) {
		const a = this.store.agent, ws = cwd();
		if (this.turn) return;
		if (!ws) { this.say("Open a folder first: the agents run in the workspace."); return; }
		if (!onPath(exe(a))) { this.say(`${NAMES[a]} is not installed on this machine. Install it, then send again:  ${INSTALL[a]}`); return; }
		let prompt = text;
		if (this.store.handoff) {   // once: the turns this agent did not see, text only, the last 20 (renderTurns caps and cuts)
			const turns = this.missed(a);
			if (turns.length) prompt = `You are continuing a conversation the user was having with ${NAMES[other(a)]} in this same chat. These are the turns you did not see (\"Assistant\" is ${NAMES[other(a)]}). Continue from them; do not repeat them.\n\n${renderTurns(turns)}\n\n---\n\n${text}`;
			this.store.handoff = false;
		}
		this.store.entries.push({ kind: "user", text, at: Date.now() });
		this.save(); this.push();
		try {
			if (a === "claude") this.sendClaude(ws, prompt); else this.sendGpt(ws, prompt);
		} catch (e) { this.turn = undefined; this.say(`${NAMES[a]} could not start: ${e}`); }
	}

	// The user and assistant turns since `a` last spoke (all of them for an agent new to this chat).
	private missed(a: Agent): Turn[] {
		const es = this.store.entries, from = es.map((e) => e.agent).lastIndexOf(a) + 1;
		return es.slice(from).filter((e) => e.kind === "user" || e.kind === "assistant").map((e) => ({ role: e.kind as Turn["role"], text: e.text }));
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
			...argsOf("claude"), ...(brief ? ["--append-system-prompt-file", brief] : []), resume ? "--resume" : "--session-id", id];
		const p = spawn(exe("claude"), args, { cwd: ws, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		this.claude = p; this.store.claude = id;
		log.info(`chat: Claude started (pid ${p.pid}, ${resume ? "resume" : "session"} ${id})`);
		lines(p, (e) => this.onEvent("claude", e), (s) => { if (this.turn?.agent === "claude") this.turn.err += s; log.warn(`chat: claude: ${s.trim()}`); });
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
			"-c", `developer_instructions=${JSON.stringify(BRIEF_CORE)}`, ...(thread ? [thread] : []), "-"];
		const p = spawn(exe("gpt"), args, { cwd: ws, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		this.turn = { agent: "gpt", proc: p, started: false, err: "" };
		log.info(`chat: GPT started (pid ${p.pid}${thread ? `, thread ${thread}` : ""})`);
		lines(p, (e) => this.onEvent("gpt", e), (s) => { if (this.turn?.proc === p) this.turn.err += s; log.warn(`chat: codex: ${s.trim()}`); });
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
		try { const s = JSON.parse(fs.readFileSync(this.file(), "utf8")); if (Array.isArray(s.entries)) { for (const e of s.entries) e.open = false; return s; } } catch { /* first time */ }
		return { agent: "claude", entries: [] };
	}
	private save() {
		try { const f = this.file(); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(this.store)); } catch (e) { log.warn(`chat: could not save the transcript: ${e}`); }
	}
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
