// luau-lsp's Roblox Studio companion plugin, installed as a local plugin so Studio streams the live DataModel
// to luau-lsp: RemoteEvents, Parts, GUIs, everything Script Sync does not put on disk (sourcemap.ts covers the
// scripts). Source: https://github.com/JohnnyMorganz/luau-lsp/tree/1.69.0/plugin (MIT), vendored byte for byte
// in ../studio-plugin with its LICENSE.md; the same code Creator Store asset 10913122509 is built from.
//
// How it works (plugin/src/LSPManager.luau, ServerEndpoints.luau): HttpService.RequestAsync to
// http://localhost:3667 (GET /get-file-paths, POST /full with the gzipped JSON tree, POST /clear). The luau-lsp
// VS Code extension (editors/code/src/roblox.ts) runs that express listener when the plugin setting is on and
// forwards the tree to the server as $/plugin/full; the server merges it into the sourcemap tree
// (src/platform/roblox/RobloxStudioPlugin.cpp: plugin-only instances are added, synced scripts get their file
// paths, plugin-managed nodes are pruned on /clear). It writes the merged tree back to sourcemap.json only when
// luau-lsp.sourcemap.autogenerate is on, which Parlay turns off, so sourcemap.ts stays the only writer.
//
// Connecting (plugin/src/init.server.luau): the "Luau" toolbar button toggles it, but the plugin also
// auto-connects, silently retrying, whenever the place is Script Syncing (InstanceFileSyncService has instances),
// which every Parlay project is. Plugins ignore the place's Allow HTTP Requests setting and instead prompt once
// per host (https://devforum.roblox.com/t/introducing-plugin-http-permissions/493269;
// https://create.roblox.com/docs/cloud-services/http-service: "Plugins can also communicate with other software
// running on the same computer through the localhost and 127.0.0.1 hosts"), so Studio asks about localhost once.
// The plugin keeps its settings as TestService.LuauLSP_Settings in the open place (cloned from
// Settings/DefaultSettings.luau when absent).
//
// Local plugins: any .rbxm/.rbxmx in %LOCALAPPDATA%\Roblox\Plugins loads when Studio starts; with Studio's
// "Reload plugin on file changes" setting on, a new or changed file loads at once
// (https://devforum.roblox.com/t/reload-plugin-on-file-changes-triggering-unnecessary-reload-when-new-plugin-is-installed/2452802).
//
// Server side: package.json sets luau-lsp.plugin.enabled, the deprecated key, in configurationDefaults on
// purpose. roblox.ts getStudioPluginValue() honours only explicit user/workspace values of
// luau-lsp.studioPlugin.* (inspect) and otherwise reads getConfiguration("luau-lsp.plugin").get(), which is the
// lookup that sees extension defaults. Both keys are window scoped, which configurationDefaults accepts.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { buildRbxmx } from "./rbxmx";
import { log } from "./studio";

export const PLUGIN_VERSION = "1.69.0";   // the luau-lsp tag ../studio-plugin/src was copied from; build/parlay/fetch-builtins.sh ships the same luau-lsp
export const STAMP = `\n-- ParlayLuauLsp ${PLUGIN_VERSION}\n`;   // trails the root script's Source

// Written when missing or different (a new vendored version changes the stamp, and any source change changes
// the bytes); an identical file is left alone so Studio's file watcher does not reload the plugin for nothing.
// Nothing else in the Plugins folder is touched.
export function installStudioPlugin(ctx: vscode.ExtensionContext) {
	const roblox = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Roblox");
	if (!roblox || !fs.existsSync(roblox)) return;   // no Studio on this machine
	const out = path.join(roblox, "Plugins", "ParlayLuauLsp.rbxmx");
	try {
		const xml = buildRbxmx(path.join(ctx.extensionPath, "studio-plugin", "src"), "plugin", STAMP);
		if (fs.existsSync(out) && fs.readFileSync(out, "utf8") === xml) { log.info(`Studio plugin ${PLUGIN_VERSION} up to date: ${out}`); return; }
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, xml);
		log.info(`installed luau-lsp Studio plugin ${PLUGIN_VERSION}: ${out} (Studio loads it at its next start, or at once if it reloads plugins on file changes)`);
	} catch (e) { log.warn(`Studio plugin install failed: ${(e as Error).message}`); }
}
