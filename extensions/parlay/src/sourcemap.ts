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
const SKIP = new Set([".git", ".vscode", ".claude", "node_modules", "assets"]);

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
	const folders = new Map<string, vscode.Disposable>();
	const attach = (folder: vscode.WorkspaceFolder) => {
		const ws = folder.uri.fsPath;
		if (folders.has(ws)) return;
		const out = path.join(ws, "sourcemap.json");
		let timer: NodeJS.Timeout | undefined;
		const write = () => {
			try {
				// Studio may populate an initially empty project after extension activation.
				// Keep watching even when no service exists yet; Rojo retains ownership of its map.
				if (fs.existsSync(path.join(ws, "default.project.json"))) return;
				if (![...SERVICES, ...STARTER].some(name => fs.existsSync(path.join(ws, name)))) return;
				const json = generateSourcemap(ws);
				if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== json) fs.writeFileSync(out, json);
			} catch (e) { console.warn("parlay sourcemap:", (e as Error).message); }
		};
		const bump = (uri: vscode.Uri) => {
			// Ignore our own output, but rebuild if somebody deletes it.
			if (uri.fsPath === out && fs.existsSync(out)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(write, 400);
		};
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
		const subscriptions = [watcher, watcher.onDidCreate(bump), watcher.onDidDelete(bump), watcher.onDidChange(bump)];
		folders.set(ws, { dispose: () => { if (timer) clearTimeout(timer); for (const subscription of subscriptions) subscription.dispose(); } });
		write();
	};
	for (const folder of vscode.workspace.workspaceFolders ?? []) attach(folder);
	ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
		for (const folder of event.removed) { folders.get(folder.uri.fsPath)?.dispose(); folders.delete(folder.uri.fsPath); }
		for (const folder of event.added) attach(folder);
	}), { dispose: () => { for (const subscription of folders.values()) subscription.dispose(); folders.clear(); } });
}
