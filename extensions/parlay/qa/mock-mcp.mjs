// A stand-in for Roblox's Studio MCP server: the same stdio JSON-RPC 2.0 protocol and tool names, answering
// from qa/fixtures. Scripted so the runner's logic gets exercised without a Studio: Edit → Play on
// start_stop_play, a console that grows two lines per read (one seeded error, printed twice) and then
// freezes, probes that always return the same position, so the stuck detector has to fire.
// PARLAY_QA_MOCK_SEAT=taken answers every tool the way the real server does while another client holds the seat.
// PARLAY_QA_MOCK_CHATTY=1 adds one identical info line to every console read, like a game's analytics heartbeat:
// the run must still exhaust and register stuck (a repeat of a known line is not news, docs/jev-research.md E6).
// PARLAY_QA_MOCK_MENU=1 gives the Menu button a panel: a Close button that the client probe lists only right after
// Menu was clicked and that any other click hides again, so the runner's reopen bookkeeping (3.2) has a menu to reopen.
import fs from "node:fs";
import readline from "node:readline";

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const consoleLines = fixture("console.txt").trimEnd().split(/\r?\n/);
const CHATTY = process.env.PARLAY_QA_MOCK_CHATTY === "1", HEARTBEAT = "[Analytics] heartbeat (studio, not sent)";
const MENU = process.env.PARLAY_QA_MOCK_MENU === "1", MENU_PATH = "LocalPlayer.PlayerGui.HUD.MenuButton";
const CLOSE = { path: "LocalPlayer.PlayerGui.HUD.Panel.CloseButton", text: "Close", class: "TextButton", parent: "Panel", x: 640, y: 200, interactable: true, active: true, inWindow: true };
const state = { mode: "Edit", consoleReads: 0, log: [], lastClick: "" };
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const text = (t) => ({ content: [{ type: "text", text: t }] });

const tools = {
	list_roblox_studios: () => text(fixture("studios.json")),
	get_studio_state: () => text(fixture(state.mode === "Play" ? "state-play.txt" : "state-edit.txt")),
	start_stop_play: ({ is_start }) => { state.mode = is_start ? "Play" : "Edit"; return text(is_start ? "Play started" : "Play stopped"); },
	// the whole log so far, like Studio; two more lines each read until the fixture runs out (and the heartbeat, in order, so
	// each read extends the last: the runner diffs by prefix)
	get_console_output: () => {
		const n = ++state.consoleReads;
		state.log.push(...consoleLines.slice((n - 1) * 2, n * 2));
		if (CHATTY) state.log.push(HEARTBEAT);
		return text(state.log.join("\n"));
	},
	execute_luau: ({ code }) => {
		if (/PARLAY_QA_PROBE server/.test(code)) return text(fixture("probe-server.json"));
		if (/PARLAY_QA_PROBE client/.test(code)) {
			if (!MENU || state.lastClick !== MENU_PATH) return text(fixture("probe-client.json"));
			const probe = JSON.parse(fixture("probe-client.json"));
			probe.buttons.push(CLOSE);
			return text(JSON.stringify(probe));
		}
		return text("arrived");   // the MoveTo snippet
	},
	user_mouse_input: ({ actions }) => { state.lastClick = actions?.[0]?.instance_path ?? ""; return text("ok"); },
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
