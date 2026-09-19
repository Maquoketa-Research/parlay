// The one check for the chat event parsing: node tools/chat-check.mjs   (node 24 runs the .ts as is)
// The fixtures are lines both CLIs printed on Sep 18 2026 (Claude Code 2.1.278 stream-json, Codex 0.155 --json),
// noise lines dropped and the init event cut to its named fields.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyClaude, applyCodex, command, summary } from "../src/chatEvents.ts";

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f) => readFileSync(join(here, "fixtures", f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const run = (apply, f) => { const entries = [], effects = []; for (const e of lines(f)) effects.push(apply(entries, e, 0)); return { entries, effects }; };

// Claude: a streamed text bubble, two tool cards with their results, "done", then the denied-tool lines
{
	const { entries, effects } = run(applyClaude, "claude-stream.jsonl");
	assert.equal(effects[0].session, "84249d6a-6512-4424-872a-23b160fca07e");
	assert.deepEqual(entries.map((x) => [x.kind, x.agent, x.name ?? x.text]), [
		["assistant", "claude", "Running the echo, then writing probe.txt."],
		["tool", "claude", "Bash"],
		["tool", "claude", "Write"],
		["assistant", "claude", "done"],
		["system", undefined, entries[4].text],
	]);
	assert.equal(entries[0].open, false, "the whole assistant block closes the streamed bubble");
	assert.equal(entries[1].text, "echo hi");
	assert.match(entries[1].detail, /→ hi$/);
	assert.equal(entries[2].text.split(/[\\/]/).pop(), "probe.txt");
	assert.match(entries[2].detail, /File created successfully/);
	assert.equal(entries[1].error, undefined);
	assert.match(entries[4].text, /wanted to run Bash/);
	const done = effects.filter((f) => f.done);
	assert.equal(done.length, 1);
	assert.equal(done[0].error, undefined);
	assert.ok(done[0].cost > 0.5);
}

// Codex: two turns on one thread: a message, two commands, a message; then a message, a patch, a message
{
	const { entries, effects } = run(applyCodex, "codex-exec.jsonl");
	assert.equal(effects[0].session, "01a0b7df-96f0-77d0-8367-d14ef7fd9af2");
	assert.deepEqual(entries.map((x) => [x.kind, x.name ?? x.text]), [
		["assistant", "I’ll run the command and create the file."],
		["tool", "command"], ["tool", "command"],
		["assistant", "done"],
		["assistant", "I’ll update the file using apply_patch."],
		["tool", "patch"],
		["assistant", "patched"],
	]);
	assert.equal(entries[1].text, "echo hi", "the powershell wrapper is stripped");
	assert.match(entries[1].detail, /→ hi/);
	assert.equal(entries[5].text, "update parlay-chat-probe/codex-probe.txt");
	assert.equal(effects.filter((f) => f.done).length, 2, "one turn.completed per turn");
	assert.equal(entries.filter((x) => x.kind === "tool").length, 3, "item.started and item.completed share one card");
}

// odd input never throws
assert.deepEqual(applyClaude([], null), {});
assert.deepEqual(applyCodex([], { type: "turn.failed", error: { message: "quota" } }), { done: true, error: "quota" });
assert.equal(summary({ file_path: "C:\\w\\Door.luau", old_string: "x" }), "C:\\w\\Door.luau");
assert.equal(summary({ description: "look  around", prompt: "…" }), "look around");
assert.equal(command("\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'echo hi'"), "echo hi");
// the page's markdown subset (media/chat.js up to its first stateful line, run as plain functions)
const page = readFileSync(join(here, "..", "media", "chat.js"), "utf8");
const { md } = new Function(`const acquireVsCodeApi = () => ({}); ${page.slice(0, page.indexOf("let state"))}; return { md };`)();
assert.equal(md(["Hi **there** `x<y`", "", "- a", "- b", "", "```lua", 'print("<")', "```", "See [docs](https://x.y/z)."].join("\n")),
	'<p>Hi <b>there</b> <code>x&lt;y</code></p><ul><li>a</li><li>b</li></ul><pre><code>print(&quot;&lt;&quot;)</code></pre><p>See <a href="https://x.y/z">docs</a>.</p>');
assert.equal(md("<img onerror=x>"), "<p>&lt;img onerror=x&gt;</p>", "agent text is never HTML");
console.log("chat-check: ok");
