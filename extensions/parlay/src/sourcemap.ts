// A Rojo-style sourcemap.json derived from a Script Sync folder, so luau-lsp can resolve instance requires
// (require(ReplicatedStorage.Modules.DataStore)) and type the tree. Script Sync mirrors the DataModel:
// folder = container, X.server.luau = Script, X.client.luau = LocalScript, X.luau = ModuleScript,
// init.*.luau = the folder itself is that script. Non-script instances are not on disk; luau-lsp's Studio
// companion plugin adds those when it is connected.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const SERVICES = new Set([
	"Workspace", "Players", "Lighting", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService", "ServerStorage",
	"StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Chat", "TextChatService", "Teams", "LocalizationService",
	"TestService", "MaterialService", "MarketplaceService", "VoiceChatService",
]);
const STARTER = new Set(["StarterPlayerScripts", "StarterCharacterScripts"]);
const SKIP = new Set([".git", ".vscode", ".claude", "node_modules", "assets", "Packages", "DevPackages"]);

interface Node { name: string; className: string; filePaths?: string[]; children?: Node[] }

function scriptOf(file: string): { name: string; className: string } | undefined {
	const m = /^(.*?)(?:\.(server|client|local|legacy|plugin))?\.(luau|lua)$/i.exec(file);
	if (!m) return;
	const kind = (m[2] ?? "").toLowerCase();
	const className = kind === "server" || kind === "legacy" ? "Script" : kind === "client" || kind === "local" ? "LocalScript" : kind === "plugin" ? "Script" : "ModuleScript";
	return { name: m[1], className };
}

function build(dir: string, root: string, name: string, className: string): Node {
	const node: Node = { name, className, children: [] };
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		const rel = path.relative(root, full).replace(/\\/g, "/");
		if (entry.isDirectory()) {
			const cls = dir === root && SERVICES.has(entry.name) ? entry.name : STARTER.has(entry.name) ? entry.name : "Folder";
			node.children!.push(build(full, root, entry.name, cls));
			continue;
		}
		const s = scriptOf(entry.name);
		if (!s) continue;
		if (s.name === "init") { node.className = s.className; node.filePaths = [rel]; continue; }
		node.children!.push({ name: s.name, className: s.className, filePaths: [rel] });
	}
	if (!node.children!.length) delete node.children;
	return node;
}

export function generateSourcemap(root: string): string {
	const game = build(root, root, "game", "DataModel");
	// Script Sync writes StarterPlayerScripts and StarterCharacterScripts as top-level folders; in the DataModel
	// they live under StarterPlayer, and that is where luau-lsp must find them for game.StarterPlayer.X to resolve
	const starters = (game.children ?? []).filter((c) => STARTER.has(c.name));
	if (starters.length) {
		game.children = game.children!.filter((c) => !STARTER.has(c.name));
		let sp = game.children.find((c) => c.name === "StarterPlayer");
		if (!sp) { sp = { name: "StarterPlayer", className: "StarterPlayer" }; game.children.push(sp); }
		sp.children = [...(sp.children ?? []).filter((c) => !STARTER.has(c.name)), ...starters];
	}
	return JSON.stringify(game);
}

// Keep sourcemap.json current for Roblox-shaped workspaces that are not Rojo projects (Rojo makes its own).
export function startSourcemap(ctx: vscode.ExtensionContext) {
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!ws) return;
	const roblox = [...SERVICES].some((n) => fs.existsSync(path.join(ws, n)));
	if (!roblox || fs.existsSync(path.join(ws, "default.project.json"))) return;
	const out = path.join(ws, "sourcemap.json");
	const write = () => {
		try {
			const json = generateSourcemap(ws);
			if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== json) fs.writeFileSync(out, json);
		} catch (e) { console.warn("parlay sourcemap:", (e as Error).message); }
	};
	write();
	let timer: NodeJS.Timeout | undefined;
	const bump = () => { if (timer) clearTimeout(timer); timer = setTimeout(write, 400); };
	const w = vscode.workspace.createFileSystemWatcher("**/*.{luau,lua}");
	ctx.subscriptions.push(w, w.onDidCreate(bump), w.onDidDelete(bump), w.onDidChange(bump));
	const d = vscode.workspace.createFileSystemWatcher("**/");
	ctx.subscriptions.push(d, d.onDidCreate(bump), d.onDidDelete(bump));
}
