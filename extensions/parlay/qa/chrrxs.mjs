// Chrrxs (github.com/Chrrxs/robloxstudio-mcp) as the runner's second way into Studio. Roblox's built-in Studio
// MCP seats one client per machine; Chrrxs is a Studio plugin plus a local server whose HTTP bridge any number
// of clients may call, so a QA run can share a PC with a Claude session that holds the built-in seat. Same
// call(name, args, ms) → { text, content } contract as mcp.mjs, translating the runner's built-in tool names:
//   list_roblox_studios → get_connected_instances        get_studio_state → solo_playtest status
//   start_stop_play → solo_playtest start|stop            execute_luau → execute_luau | eval_server_runtime | eval_client_runtime
//   get_console_output → get_runtime_logs, accumulated into the whole log so far (what the built-in returns)
//   screen_capture → capture_screenshot                   user_keyboard_input → simulate_keyboard_input, one call per action
//   user_mouse_input → simulate_mouse_input (viewport pixels; the runner passes the button's x, y from the client probe)
// Bridge: POST http://127.0.0.1:58741/mcp/<tool> with X-MCP-Auth (the token the server writes to
// ~/.robloxstudio-mcp/auth-token, or ROBLOX_STUDIO_AUTH_TOKEN). When nothing listens, the runner starts the server
// itself (npx, the pinned version) with --auto-install-plugin, which drops MCPPlugin.rbxmx into
// %LOCALAPPDATA%\Roblox\Plugins; Studio loads local plugins live and the plugin connects to the bridge.
// PARLAY_QA_CHRRXS_URL overrides the bridge (qa-check's mock). Contract read from @chrrxs/robloxstudio-mcp 3.1.5.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHRRXS_VERSION = "3.1.5";
const url = () => process.env.PARLAY_QA_CHRRXS_URL || "http://127.0.0.1:58741";
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), "chrrxs:", ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenFile = path.join(os.homedir(), ".robloxstudio-mcp", "auth-token");
const token = () => process.env.ROBLOX_STUDIO_AUTH_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");

// GET /health needs no token: { pluginConnected, instanceCount, version }; null when nothing listens
export async function health(ms = 1500) {
	try { const r = await fetch(`${url()}/health`, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

// a tool result's text blocks, or the structured body the route sends alone when there are no blocks
const textOf = (body) => Array.isArray(body?.content) ? body.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : JSON.stringify(body);
const json = (text) => { try { return JSON.parse(text); } catch { return {}; } };
const last = (s) => s.trim().split("\n").pop() ?? "";

export async function connect({ timeoutMs = 30000 } = {}) {
	let child, err = "";
	if (!(await health())) {
		// nobody runs the server: start it. stdin stays open (the MCP stdio transport exits on EOF); a shell, since
		// npx is a .cmd on Windows. First run downloads the package, so the wait is generous.
		log(`no bridge at ${url()}; starting @chrrxs/robloxstudio-mcp@${CHRRXS_VERSION} (installs its Studio plugin when missing)`);
		child = spawn(`npx -y @chrrxs/robloxstudio-mcp@${CHRRXS_VERSION} --auto-install-plugin`, { shell: true, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
		child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
		child.on("error", (e) => { err += e.message; });
		for (const t0 = Date.now(); !(await health()); await sleep(1000)) {
			if (child.exitCode !== null) throw new Error(`Chrrxs server exited (${child.exitCode}): ${last(err) || "is npx on PATH?"}`);
			if (Date.now() - t0 > 90000) { kill(child); throw new Error(`Chrrxs server did not answer on ${url()} within 90 s: ${last(err)}`); }
		}
	}
	// The plugin connects on its own, but Studio loads local plugins at startup only (Chrrxs: "fully close and reopen
	// Studio after installation"), so windows that were open before the install never connect.
	const started = Date.now();
	for (; ; await sleep(2000)) {
		const h = await health();
		if (h?.pluginConnected) break;
		if (Date.now() - started > 60000) {
			if (child) kill(child);
			const plugin = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "Plugins", "MCPPlugin.rbxmx");
			const fresh = fs.existsSync(plugin) && fs.statSync(plugin).mtimeMs > started - 120000;
			throw new Error(fresh
				? "the Chrrxs Studio plugin was just installed and Studio only loads plugins at startup: close every Studio window, open the place again, and run again (its toolbar then shows MCP Server: Connected)"
				: "the Chrrxs bridge is up but no Studio window has its plugin connected: restart Studio (it loads plugins at startup) and check Plugins > Manage Plugins for MCPPlugin");
		}
	}
	const key = token();
	if (!key) { if (child) kill(child); throw new Error(`Chrrxs token missing (${tokenFile} or ROBLOX_STUDIO_AUTH_TOKEN)`); }

	async function invoke(name, args, ms = timeoutMs) {
		const r = await fetch(`${url()}/mcp/${name}`, { method: "POST", headers: { "content-type": "application/json", "X-MCP-Auth": key }, body: JSON.stringify(args), signal: AbortSignal.timeout(ms) });
		const body = await r.json().catch(() => ({}));
		if (r.status === 401) throw new Error(`${name}: Chrrxs rejected the token (${tokenFile})`);
		if (!r.ok) throw new Error(`${name}: ${body.error ?? body.message ?? `HTTP ${r.status}`}`.slice(0, 500));
		if (body.isError) throw new Error(`${name}: ${textOf(body).slice(0, 500)}`);
		return body;
	}
	// the plugin's Luau envelope { success, returnValue, output, error } → the returned value as the text
	const unwrap = (name, body) => {
		const d = json(textOf(body));
		if (d.success === false) throw new Error(`${name}: ${d.error ?? "failed"}`);
		return d.returnValue ?? (Array.isArray(d.output) && d.output.length ? d.output.join("\n") : textOf(body));
	};
	let consoleText = "", cursor;
	return {
		kind: "chrrxs",
		pixels: true,   // clicks want viewport x, y (the built-in takes an instance path)
		async call(name, args = {}, ms) {
			const instance_id = args.studio_id;
			switch (name) {
				case "list_roblox_studios": {
					const d = json(textOf(await invoke("get_connected_instances", {}, ms)));
					const studios = (d.instances ?? []).map((i) => ({ id: String(i.id), name: `${i.placeName || "Studio"}${i.placeId ? ` (placeId: ${i.placeId})` : ""}` }));
					return { text: JSON.stringify({ studios }), content: [] };
				}
				case "get_studio_state": {
					const d = json(textOf(await invoke("solo_playtest", { action: "status", instance_id }, ms)));
					const roles = Array.isArray(d.roles) ? ` (${d.roles.join(", ")})` : "";
					return { text: d.running ? `- Current Studio Mode: Play\n- Available DataModels: Edit, Client, Server${roles}` : "- Current Studio Mode: Edit\n- Available DataModels: Edit", content: [] };
				}
				case "start_stop_play": {
					const req = args.is_start ? { action: "start", mode: "play", timeout: 60, instance_id } : { action: "stop", timeout: 15, instance_id };
					const d = json(textOf(await invoke("solo_playtest", req, Math.max(ms ?? 0, 90000))));
					if (d.success === false) throw new Error(`solo_playtest ${req.action}: ${d.error ?? d.message ?? "failed"}`);
					return { text: d.message ?? "ok", content: [] };
				}
				case "execute_luau": {
					const realm = String(args.datamodel_type ?? "Edit").toLowerCase();
					const body = realm === "server" ? await invoke("eval_server_runtime", { code: args.code, instance_id }, ms)
						: realm === "client" ? await invoke("eval_client_runtime", { code: args.code, target: "client-1", instance_id }, ms)
							: await invoke("execute_luau", { code: args.code, target: "edit", instance_id }, ms);
					return { text: String(unwrap("execute_luau", body)), content: [] };
				}
				case "get_console_output": {
					// the first read takes the tail of what is there, later ones only what is new; the runner diffs the whole text
					const d = json(textOf(await invoke("get_runtime_logs", { instance_id, ...(cursor ? { cursor } : { tail: 500 }) }, ms)));
					cursor = d.nextCursor ?? cursor;
					for (const e of d.entries ?? []) consoleText += `${typeof e === "string" ? e : e.message ?? JSON.stringify(e)}\n`;
					return { text: consoleText, content: [] };
				}
				case "screen_capture": {
					const body = await invoke("capture_screenshot", { format: "png", instance_id }, ms);
					return { text: textOf(body), content: Array.isArray(body.content) ? body.content : [] };
				}
				case "user_keyboard_input": {
					const KEY = { keyDown: "press", keyUp: "release", keyPress: "tap" };
					for (const a of args.actions ?? []) {
						if (a.action === "wait") { await sleep(a.wait_time_ms ?? 0); continue; }
						await invoke("simulate_keyboard_input", { keyCode: a.key_code, action: KEY[a.action] ?? "tap", target: "client-1", instance_id }, ms);
					}
					return { text: "ok", content: [] };
				}
				case "user_mouse_input": {
					for (const a of args.actions ?? []) {
						if (typeof a.x !== "number" || typeof a.y !== "number") throw new Error(`user_mouse_input: Chrrxs clicks by viewport pixels and ${a.instance_path ?? "this action"} came without x, y`);
						await invoke("simulate_mouse_input", { action: a.action === "mouseButtonClick" ? "click" : a.action, x: a.x, y: a.y, target: "client-1", instance_id }, ms);
					}
					return { text: "ok", content: [] };
				}
				default: throw new Error(`${name}: not available through Chrrxs`);
			}
		},
		close() { if (child) kill(child); },
	};
}

// the server was started through a shell: kill the tree, or it keeps the port
function kill(child) {
	if (!child.pid || child.exitCode !== null) return;
	if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
	else child.kill();
}
