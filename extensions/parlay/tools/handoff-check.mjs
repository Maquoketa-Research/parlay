// The one check for the handoff logic: node tools/handoff-check.mjs   (node 24 runs the .ts as is)
import assert from "node:assert/strict";
import { claudeSlug, renderHandoff, renderTurns, textTurns } from "../src/handoff.ts";

// two-line Claude transcript: a string user message, an assistant array with thinking + text + tool_use
const claude = [
	{ type: "user", message: { role: "user", content: "fix the door" }, cwd: "C:\\w", sessionId: "abc" },
	{ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Done: Door.luau" }, { type: "tool_use", name: "Edit", input: {} }] } },
	{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
	{ type: "attachment", attachment: { type: "hook_success" } },
].map((r) => JSON.stringify(r)).join("\n");
assert.deepEqual(textTurns(claude), [{ role: "user", text: "fix the door" }, { role: "assistant", text: "Done: Door.luau" }]);

// Codex rollout: session_meta, an injected context turn, a real turn, reasoning, the reply
const codex = [
	{ type: "session_meta", payload: { session_id: "01a0", cwd: "C:\\w", originator: "codex_exec" } },
	{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
	{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a lever" }] } },
	{ type: "response_item", payload: { type: "reasoning", summary: [] } },
	{ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] } },
	{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Lever added." }] } },
	{ type: "event_msg", payload: { type: "token_count" } },
].map((r) => JSON.stringify(r)).join("\n");
assert.deepEqual(textTurns(codex), [{ role: "user", text: "add a lever" }, { role: "assistant", text: "Lever added." }]);

assert.equal(claudeSlug("C:\\Users\\Dave.MAQUOKETA\\Documents\\GitHub\\drydock"), "C--Users-Dave-MAQUOKETA-Documents-GitHub-drydock");
assert.equal(renderTurns([{ role: "user", text: "a".repeat(30) }], 20, 10), "**User:** aaaaaaaaaa …");

const md = renderHandoff({ agent: "claude", id: "abc", cwd: "C:\\w", mode: "--permission-mode acceptEdits", when: new Date(0) }, "## Goal\nx\n");
assert.equal(md, "# Handoff from Claude\n\n- From: Claude (Claude Code)\n- Session: abc\n- Workspace: C:\\w\n- Permissions: --permission-mode acceptEdits\n- Written: 1970-01-01T00:00:00.000Z\n\n## Goal\nx\n");
console.log("handoff-check: ok");
