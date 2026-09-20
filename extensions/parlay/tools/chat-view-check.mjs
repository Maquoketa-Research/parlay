// Exercise the real Chat controller with mocked VS Code and child processes. No agents or network calls.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as events from "../src/chatEvents.ts";
import * as handoff from "../src/handoff.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "parlay-chat-check-"));
const ctx = { globalStorageUri: { fsPath: root }, subscriptions: [] };
const processes = [], errors = [], commands = [];
let chat, failArchive = false;
const noop = () => ({ dispose() {} });
const vscode = {
 workspace: { workspaceFolders: [{ uri: { fsPath: root }, name: "Test project" }], isTrusted: false, onDidGrantWorkspaceTrust: noop },
 window: {
  registerWebviewViewProvider(_id, provider) { chat = provider; return noop(); },
  showInformationMessage: noop,
  showErrorMessage(message) { errors.push(message); },
  async showQuickPick(items) { return items[0]; },
 },
 commands: { executeCommand: async command => commands.push(command), registerCommand: noop },
};
const mockSpawn = () => {
 const p = new EventEmitter();
 p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
 p.kill = () => { p.killed = true; }; processes.push(p); return p;
};
const dependencies = {
 vscode, crypto, path,
 fs: { ...fs, writeFileSync(file, content) { if (failArchive && path.basename(path.dirname(file)) !== "chat") throw new Error("Disk full"); return fs.writeFileSync(file, content); } },
 child_process: { spawn: mockSpawn },
 "./agents": { agentBrief: () => "test modes", exe: () => "mock-agent", onPath: () => true, argsOf: () => [], writeBrief: () => undefined },
 "./agentOptions": { agentOptions: () => ({ model: "", effort: "", fast: false }), optionArgs: () => [], configureAgent: async () => false },
 "./chatEvents": events, "./handoff": handoff,
 "./agentStatus": { agentStatus: async () => ({ installed: true, authenticated: true, label: "Connected" }) },
 "./log": { log: { info() {}, warn() {} } },
};
const source = fs.readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
runInNewContext(output, { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, process, setTimeout, clearTimeout });
const event = (p, value) => p.stdout.write(JSON.stringify(value) + "\n");
try {
 exports.registerChat(ctx);
 assert.equal(await chat.send("Keep this draft"), false, "Restricted Mode rejects the send before spawning");
 assert.equal(processes.length, 0);
 chat.fresh();
 vscode.workspace.isTrusted = true; // Only the mocked workspace in this unit test.
 chat.use("gpt");
 chat.attachment = { label: "test.luau:1–2", text: "print(42)" };
 assert.equal(await chat.send("Explain this"), true);
 const old = processes.at(-1), prompt = old.stdin.read().toString();
 assert.match(prompt, /Attached code from test.luau:1–2/);
 assert.match(prompt, /print\(42\)/);
 event(old, { type: "thread.started", thread_id: "test-thread" });
 event(old, { type: "item.completed", item: { type: "agent_message", text: "It prints 42." } });
 event(old, { type: "turn.completed" });
 const savedId = chat.store.id;
 chat.fresh();
 assert.equal(chat.store.entries.length, 0);
 event(old, { type: "item.completed", item: { type: "agent_message", text: "Late output must be ignored." } });
 assert.equal(chat.store.entries.length, 0, "a retired process cannot write into a new conversation");
 await chat.history();
 assert.equal(chat.store.id, savedId);
 assert.equal(chat.store.gpt, "test-thread", "resuming history preserves the agent session");
 assert.equal(chat.store.entries[0].context.text, "print(42)");
 assert.equal(chat.store.entries.at(-1).text, "It prints 42.");
 failArchive = true;
 chat.fresh();
 assert.equal(chat.store.id, savedId, "a failed archive cannot erase the active conversation");
 assert.equal(errors.length, 1);
 failArchive = false;
 chat.fresh();
 chat.use("gpt");
 const draftAttachment = { label: "draft.luau", text: "keep this" };
 chat.attachment = draftAttachment;
 assert.equal(await chat.sendAction("Explain selected code", { label: "unsaved.luau:2-3", text: "print('unsaved')" }, "Explain without edits."), true);
 assert.equal(commands.at(-1), "parlay.chat.focus");
 const actionProcess = processes.at(-1);
 const actionPrompt = actionProcess.stdin.read().toString();
 assert.match(actionPrompt, /Explain without edits/);
 assert.match(actionPrompt, /print\('unsaved'\)/);
 assert.ok(!actionPrompt.includes("keep this"));
 assert.equal(chat.store.agent, "gpt", "editor actions respect the selected Chat agent");
 assert.equal(chat.attachment, draftAttachment, "an editor action preserves the composer's attachment");
 const count = processes.length;
 assert.equal(await chat.sendAction("Second action"), false);
 assert.equal(processes.length, count, "busy chat must not spawn a second agent");
 console.log("chat-view-check: ok — trust guard, attachments, history, late events, archive failure");
} finally {
 chat?.dispose();
 fs.rmSync(root, { recursive: true, force: true });
}
