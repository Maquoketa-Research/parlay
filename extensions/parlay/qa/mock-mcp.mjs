// A stand-in for Roblox's Studio MCP server: the same stdio JSON-RPC 2.0 protocol and tool names, answering
// from qa/fixtures. Scripted so the runner's logic gets exercised without a Studio: Edit → Play on
// start_stop_play, a console that grows two lines per read (one seeded error, printed twice) and then
// freezes, probes that always return the same position, so the stuck detector has to fire.
// PARLAY_QA_MOCK_SEAT=taken answers every tool the way the real server does while another client holds the seat.
import fs from "node:fs";
import readline from "node:readline";

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const consoleLines = fixture("console.txt").trimEnd().split(/\r?\n/);
const state = { mode: "Edit", consoleReads: 0 };
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const text = (t) => ({ content: [{ type: "text", text: t }] });

const tools = {
	list_roblox_studios: () => text(fixture("studios.json")),
	get_studio_state: () => text(fixture(state.mode === "Play" ? "state-play.txt" : "state-edit.txt")),
	start_stop_play: ({ is_start }) => { state.mode = is_start ? "Play" : "Edit"; return text(is_start ? "Play started" : "Play stopped"); },
	// the whole log so far, like Studio; two more lines each read until the fixture runs out
	get_console_output: () => text(consoleLines.slice(0, Math.min(consoleLines.length, ++state.consoleReads * 2)).join("\n")),
	execute_luau: ({ code }) => {
		if (/PARLAY_QA_PROBE server/.test(code)) return text(fixture("probe-server.json"));
		if (/PARLAY_QA_PROBE client/.test(code)) return text(fixture("probe-client.json"));
		return text("arrived");   // the MoveTo snippet
	},
	user_mouse_input: () => text("ok"),
	user_keyboard_input: () => text("ok"),
	search_game_tree: () => text(fixture("tree.json")),
	screen_capture: () => ({ content: [{ type: "image", data: PNG_1PX, mimeType: "image/png" }] }),
};

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let msg; try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined) return;   // notifications/initialized and friends
	if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-studio-mcp", version: "0" } } });
	if (msg.method !== "tools/call") return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
	const { name, arguments: args = {} } = msg.params ?? {};
	if (process.env.PARLAY_QA_MOCK_SEAT === "taken") return send({ id: msg.id, result: text("Unable to reach Roblox Studio") });
	const tool = tools[name];
	if (!tool) return send({ id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
	if (name !== "list_roblox_studios" && !args.studio_id) return send({ id: msg.id, error: { code: -32602, message: `${name}: studio_id required` } });
	send({ id: msg.id, result: tool(args) });
});
