// Parlay chat: the pure half. Turns the events the two CLIs stream into transcript entries. No vscode import,
// so tools/chat-check.mjs runs it under plain node against the fixtures captured live (tools/fixtures/).
import type { Agent } from "./handoff";   // type-only: plain node strips it, no extension needed

export interface Entry {
	kind: "user" | "assistant" | "tool" | "system";
	agent?: Agent;      // who said it (user and system entries: none)
	text: string;       // the message; for a tool card its one-line summary
	name?: string;      // tool card: the tool (Bash, Edit, command, patch, …)
	detail?: string;    // tool card: what it was called with, then what came back
	id?: string;        // tool card: the tool_use / item id its result is matched by
	open?: boolean;     // assistant bubble still being streamed into
	error?: boolean;    // tool card whose result was an error
	at: number;
	context?: { label: string; text: string };
}

// What one event did beyond the entries: the turn ended (with an error when it failed), a session id was
// learned, the running cost so far.
export interface Effect { done?: boolean; error?: string; session?: string; cost?: number }

// Claude Code 2.1.278, `claude -p --output-format stream-json --input-format stream-json --verbose
// --include-partial-messages` (verified live Sep 18 2026, one process, user messages on stdin as
// {"type":"user","message":{"role":"user","content":"…"}}). Per turn: system/init {session_id, model,
// permissionMode, cwd} → stream_event {event: message_start | content_block_start {content_block} |
// content_block_delta {delta: text_delta {text} | input_json_delta {partial_json}} | content_block_stop |
// message_delta | message_stop} → assistant {message.content: [text | tool_use {id, name, input} | thinking]}
// (each block whole, after its deltas) → user {message.content: [tool_result {tool_use_id, content, is_error}]}
// → … → result {subtype: success | error_during_execution, is_error, total_cost_usd, num_turns, session_id,
// permission_denials}. A tool that would prompt is denied outright in this mode (no control_request ever
// reaches stdout): system/permission_denied {tool_name, tool_use_id, message} plus an is_error tool_result.
// Noise: system/status, system/thinking_tokens, system/hook_*, rate_limit_event, control_response.
export function applyClaude(entries: Entry[], e: any, now = Date.now()): Effect {
	const last = entries[entries.length - 1];
	const open = last?.kind === "assistant" && last.agent === "claude" && last.open ? last : undefined;
	switch (e?.type) {
		case "system":
			if (e.subtype === "init") return { session: String(e.session_id ?? "") || undefined };
			if (e.subtype === "permission_denied") entries.push({ kind: "system", text: `Claude wanted to run ${e.tool_name} and nothing here can approve it (${e.message}). Run that from the agent terminal, or set parlay.claudeArgs to a wider permission mode.`, at: now });
			return {};
		case "stream_event": {
			const ev = e.event;
			if (ev?.type === "content_block_start" && ev.content_block?.type === "text") { if (!open) entries.push({ kind: "assistant", agent: "claude", text: "", open: true, at: now }); }
			else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
				if (open) open.text += ev.delta.text;
				else entries.push({ kind: "assistant", agent: "claude", text: String(ev.delta.text), open: true, at: now });
			}
			return {};
		}
		case "assistant":
			for (const b of blocks(e.message?.content)) {
				if (b.type === "text") {   // the whole block: authoritative over the deltas
					const o = entries[entries.length - 1];
					if (o?.kind === "assistant" && o.agent === "claude" && o.open) { o.text = b.text; o.open = false; }
					else if (String(b.text).trim()) entries.push({ kind: "assistant", agent: "claude", text: b.text, at: now });
				} else if (b.type === "tool_use") entries.push({ kind: "tool", agent: "claude", name: b.name, text: summary(b.input), detail: pretty(b.input), id: b.id, at: now });
			}
			return {};
		case "user":
			for (const b of blocks(e.message?.content)) {
				if (b.type !== "tool_result") continue;
				const card = cardInTurn(entries, b.tool_use_id);
				const out = text(b.content);
				if (card) { card.detail = `${card.detail ?? ""}\n\n→ ${out || "(no output)"}`.trim(); if (b.is_error) card.error = true; }
			}
			return {};
		case "result":
			if (open) open.open = false;
			return { done: true, error: e.is_error ? String(e.result ?? e.subtype ?? "error") : undefined, cost: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined };
	}
	return {};
}

// Codex CLI 0.155.0-alpha.9, `codex exec --json … -` and `codex exec resume <thread> --json … -` (prompt on stdin;
// verified live Sep 18 2026). One process per turn: thread.started {thread_id} → turn.started → item.started /
// item.completed {item: agent_message {text} | command_execution {command, aggregated_output, exit_code, status} |
// file_change {changes: [{path, kind}], status}} → turn.completed {usage: {input_tokens, cached_input_tokens,
// output_tokens, reasoning_output_tokens}}. agent_message arrives whole (no deltas), so GPT text does not stream.
// Unverified (not seen in the captures): turn.failed / error events, and reasoning items; handled by shape.
export function applyCodex(entries: Entry[], e: any, now = Date.now()): Effect {
	switch (e?.type) {
		case "thread.started": return { session: String(e.thread_id ?? "") || undefined };
		case "item.started":
		case "item.completed": {
			const it = e.item ?? {};
			if (it.type === "agent_message") { if (e.type === "item.completed" && String(it.text ?? "").trim()) entries.push({ kind: "assistant", agent: "gpt", text: it.text, at: now }); return {}; }
			if (it.type === "reasoning") return {};
			let card = e.type === "item.completed" ? cardInTurn(entries, it.id) : undefined;   // item ids restart at item_0 every turn
			if (!card) { card = { kind: "tool", agent: "gpt", name: it.type === "command_execution" ? "command" : it.type === "file_change" ? "patch" : String(it.type), text: "", id: it.id, at: now }; entries.push(card); }
			if (it.type === "command_execution") {
				card.text = command(it.command);
				card.detail = e.type === "item.completed" ? `${it.command}\n\n→ ${String(it.aggregated_output ?? "").trim() || "(no output)"}${it.exit_code ? `\n(exit ${it.exit_code})` : ""}` : String(it.command ?? "");
				if (it.exit_code) card.error = true;
			} else if (it.type === "file_change") {
				const files: { kind: string; path: string }[] = (it.changes ?? []).map((c: any) => ({ kind: String(c.kind ?? "change"), path: String(c.path ?? "") }));
				card.text = files.map((f) => `${f.kind} ${f.path.split(/[\\/]/).slice(-2).join("/")}`).join(", ");
				card.detail = files.map((f) => `${f.kind} ${f.path}`).join("\n");
			} else { card.text = it.type; card.detail = pretty(it); }
			return {};
		}
		case "turn.completed": return { done: true };
		case "turn.failed": return { done: true, error: String(e.error?.message ?? e.message ?? "turn failed") };
		case "error": return { done: true, error: String(e.message ?? e.error?.message ?? "error") };
	}
	return {};
}

// The tool card with this id in the current turn: back from the end, stopping at the user message that began it.
function cardInTurn(entries: Entry[], id: unknown): Entry | undefined {
	for (let i = entries.length - 1; i >= 0 && entries[i].kind !== "user"; i--) if (entries[i].kind === "tool" && entries[i].id === id) return entries[i];
	return;
}

const blocks = (c: unknown): any[] => Array.isArray(c) ? c : typeof c === "string" ? [{ type: "text", text: c }] : [];
const text = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => String(p?.text ?? "")).join("\n") : "";
const pretty = (v: unknown) => { try { return JSON.stringify(v, null, 1).slice(0, 4000); } catch { return String(v); } };

// One line about a Claude tool call: the command, the file, the pattern; else the first string in its input.
export function summary(input: any): string {
	const i = input ?? {};
	const s = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.description ?? i.prompt ?? i.url ?? i.query ?? Object.values(i).find((v) => typeof v === "string") ?? "";
	return String(s).replace(/\s+/g, " ").trim().slice(0, 120);
}

// Codex on Windows wraps every command in a full-path powershell.exe -Command …; show what it ran.
export const command = (c: unknown) => String(c ?? "").replace(/^"[^"]*powershell\.exe"\s+-Command\s+/i, "").replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim().slice(0, 120);
