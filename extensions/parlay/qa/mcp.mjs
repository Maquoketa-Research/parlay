// Roblox Studio's MCP server over stdio (%LOCALAPPDATA%\Roblox\mcp.bat → StudioMCP.exe): JSON-RPC 2.0, one
// object per line. The same handshake as src/studio.ts studioSession(), held open for a whole play session.
// PARLAY_QA_MCP=mock runs qa/mock-mcp.mjs instead: same wire protocol, canned fixtures.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// the seat is exclusive per machine; the server answers every tool with this text while someone else holds it
export class SeatTaken extends Error {}

export async function connect({ timeoutMs = 30000 } = {}) {
	const mock = process.env.PARLAY_QA_MCP === "mock";
	const bat = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "mcp.bat");
	if (!mock && !fs.existsSync(bat)) throw new Error(`Roblox Studio MCP not found at ${bat}; install or update Studio`);
	const child = mock
		? spawn(process.execPath, [fileURLToPath(new URL("./mock-mcp.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] })
		: spawn("cmd.exe", ["/d", "/s", "/c", bat], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
	const pending = new Map();
	let nextId = 1, buf = "", closed = false;
	const fail = (err) => { closed = true; for (const p of pending.values()) p.reject(err); pending.clear(); };
	child.on("error", fail);
	child.on("exit", (code) => fail(new Error(`Studio MCP exited (${code})`)));
	child.stdin.on("error", fail);
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
			if (!line) continue;
			let msg; try { msg = JSON.parse(line); } catch { continue; }   // stray non-JSON output
			const p = pending.get(msg.id);
			if (p) { pending.delete(msg.id); p.resolve(msg); }
		}
	});
	// one JSON-RPC request; resolves with the whole response object
	const rpc = (method, params, ms = timeoutMs) => new Promise((resolve, reject) => {
		if (closed) return reject(new Error("Studio MCP session closed"));
		const id = nextId++;
		const t = setTimeout(() => { pending.delete(id); reject(new Error(`Studio MCP timed out on ${method} after ${ms} ms`)); }, ms);
		pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	});
	await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "parlay-qa", version: "0.1.0" } });
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	return {
		// tools/call → { text, content }: the text blocks joined, and the raw content for images
		async call(name, args = {}, ms) {
			const r = await rpc("tools/call", { name, arguments: args }, ms);
			if (r.error) throw new Error(`${name}: ${r.error.message ?? JSON.stringify(r.error)}`);
			const content = r.result?.content ?? [];
			const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (/unable to reach roblox studio/i.test(text)) throw new SeatTaken(`${name}: ${text.trim()} (another MCP client holds the Studio seat on this machine)`);
			if (r.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(r.result)}`);
			return { text, content };
		},
		close() {
			if (closed) return;
			fail(new Error("Studio MCP session closed"));
			// mcp.bat is a cmd.exe wrapper: kill the tree, or StudioMCP.exe stays behind holding the seat
			if (process.platform === "win32" && !mock) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
			else child.kill();
		},
	};
}
