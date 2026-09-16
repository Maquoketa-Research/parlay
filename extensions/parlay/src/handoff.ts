// Parlay: the pure half of the agents tab. Where Claude Code and Codex keep their transcripts, what a
// transcript says in plain text, and the note one agent leaves for the other. No vscode import, so
// tools/handoff-check.mjs runs it under plain node.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type Agent = "claude" | "gpt";
export const NAMES: Record<Agent, string> = { claude: "Claude", gpt: "GPT" };
export const other = (a: Agent): Agent => (a === "claude" ? "gpt" : "claude");

export interface Turn { role: "user" | "assistant"; text: string }

// What the departing agent is asked for (one turn, out of band) and what the arriving one is told.
export const SUMMARY_PROMPT = "Write a handoff note for another AI assistant that will continue this conversation in your place. Under 600 words, Markdown, with these headings: Goal, Done (files touched), Decisions, Open problems, Next step. Be concrete: paths, names, commands. Only what this conversation established; skip environment and setup facts. Do not use tools; write from the conversation only. Output only the note.";
export const CONTINUE_PROMPT = "Read .parlay/handoff.md — it is the conversation so far with another assistant. Continue from its next step.";

// Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl, slug = cwd with every non-alphanumeric turned
// into "-". Claude launched from Git Bash writes a lowercase drive letter, so the folder is matched case-insensitively.
export const claudeSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export function claudeTranscript(cwd: string, id: string): string | undefined {
	const root = path.join(os.homedir(), ".claude", "projects");
	const want = claudeSlug(cwd).toLowerCase();
	let dirs: string[] = [];
	try { dirs = fs.readdirSync(root); } catch { return; }
	for (const d of dirs) {
		const f = path.join(root, d, `${id}.jsonl`);
		if (d.toLowerCase() === want && fs.existsSync(f)) return f;
	}
	return;
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl; line 1 is session_meta with the cwd.
// Codex picks its own id, so the session is found afterwards: the newest rollout for this cwd written since
// the launch. Today's and yesterday's folders. Codex Desktop's own threads in the same folder are skipped.
export function codexTranscript(cwd: string, since: number): { id: string; file: string } | undefined {
	const root = path.join(os.homedir(), ".codex", "sessions");
	const pad = (n: number) => String(n).padStart(2, "0");
	const files: { file: string; mtime: number }[] = [];
	for (const back of [0, 1]) {
		const d = new Date(Date.now() - back * 86_400_000);
		const dir = path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
		let names: string[] = [];
		try { names = fs.readdirSync(dir); } catch { continue; }
		for (const n of names) {
			if (!n.startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
			const file = path.join(dir, n), mtime = fs.statSync(file).mtimeMs;
			if (mtime >= since) files.push({ file, mtime });
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	for (const { file } of files) {
		const meta = firstJson(file);
		if (meta?.type !== "session_meta" || meta.payload?.originator === "Codex Desktop" || !sameDir(meta.payload?.cwd, cwd)) continue;
		return { id: String(meta.payload.session_id ?? meta.payload.id), file };
	}
	return;
}

// The first line only: session_meta carries the whole base prompt, the rest of the rollout can be megabytes.
function firstJson(file: string): any {
	const buf = Buffer.alloc(256 << 10);
	const fd = fs.openSync(file, "r");
	let n = 0;
	try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
	const text = buf.toString("utf8", 0, n), nl = text.indexOf("\n");
	try { return JSON.parse(nl < 0 ? text : text.slice(0, nl)); } catch { return; }
}

const sameDir = (a: unknown, b: string) =>
	typeof a === "string" && path.normalize(a).replace(/[\\/]+$/, "").toLowerCase() === path.normalize(b).replace(/[\\/]+$/, "").toLowerCase();

// The plain-text turns of either transcript. Claude records: {type: user|assistant, message: {content}} with
// content a string or [{type: text|thinking|tool_use|tool_result}]. Codex: {type: response_item, payload:
// {type: message, role, content: [{type: input_text|output_text, text}]}}. Thinking, tool calls and results are
// dropped; so are the tag-wrapped user turns both CLIs inject (<environment_context>, <command-name>, …).
export function textTurns(jsonl: string): Turn[] {
	const out: Turn[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let r: any;
		try { r = JSON.parse(line); } catch { continue; }
		const m = r.type === "response_item" ? r.payload : r.message;
		const role = r.type === "user" || r.type === "assistant" ? r.type : m?.type === "message" ? m.role : undefined;
		if (role !== "user" && role !== "assistant") continue;
		const c = m?.content;
		const text = (typeof c === "string" ? c : Array.isArray(c)
			? c.filter((p: any) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text").map((p: any) => String(p.text ?? "")).join("\n")
			: "").trim();
		if (!text || (role === "user" && text.startsWith("<"))) continue;
		out.push({ role, text });
	}
	return out;
}

// The fallback body when the departing CLI cannot write its own note: the last turns, text only, capped.
export function renderTurns(turns: Turn[], last = 20, cut = 2000): string {
	return turns.slice(-last).map((t) => `**${t.role === "user" ? "User" : "Assistant"}:** ${t.text.length > cut ? t.text.slice(0, cut) + " …" : t.text}`).join("\n\n");
}

export interface Head { agent: Agent; id: string; cwd: string; mode: string; when?: Date }
export function renderHandoff(h: Head, body: string): string {
	return `# Handoff from ${NAMES[h.agent]}

- From: ${NAMES[h.agent]} (${h.agent === "claude" ? "Claude Code" : "Codex CLI"})
- Session: ${h.id}
- Workspace: ${h.cwd}
- Permissions: ${h.mode}
- Written: ${(h.when ?? new Date()).toISOString()}

${body.trim()}
`;
}
