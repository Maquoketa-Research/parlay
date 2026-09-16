// The one check for the Studio plugin model: node --no-warnings tools/rbxmx-check.mjs   (node 24 runs the .ts as is)
// Builds ParlayLuauLsp.rbxmx from ../studio-plugin/src into a temp file and asserts it is the tree Rojo builds
// from plugin/default.project.json at luau-lsp 1.69.0. Node has no XML parser: counts and regexes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRbxmx } from "../src/rbxmx.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = "\n-- ParlayLuauLsp 1.69.0\n";
const out = join(mkdtempSync(join(tmpdir(), "parlay-rbxmx-")), "ParlayLuauLsp.rbxmx");
writeFileSync(out, buildRbxmx(join(root, "studio-plugin", "src"), "plugin", stamp));
const text = readFileSync(out, "utf8");

assert.ok(text.startsWith('<roblox version="4">') && text.trimEnd().endsWith("</roblox>"), "one roblox root");
const opens = text.match(/<Item class="/g)?.length ?? 0;
assert.equal(opens, text.match(/<\/Item>/g)?.length ?? 0, "balanced Items");
assert.equal(new Set([...text.matchAll(/referent="([^"]+)"/g)].map((m) => m[1])).size, opens, "unique referents");
assert.equal(text.match(/<!\[CDATA\[/g)?.length ?? 0, text.match(/\]\]>/g)?.length ?? 0, "balanced CDATA");
assert.ok(text.indexOf("<Item") === text.indexOf('<Item class="Script" referent'), "the root is the Script (init.server.luau)");
// what Rojo makes of plugin/src: Settings/init.luau is a ModuleScript holding DefaultSettings, Utils has no init so it is a Folder
const items = [...text.matchAll(/<Item class="(\w+)" referent="\w+"><Properties><string name="Name">([^<]+)</g)].map((m) => `${m[1]} ${m[2]}`);
const want = ["Script plugin", "ModuleScript Assets", "ModuleScript InstanceTracker", "ModuleScript LSPManager", "ModuleScript ServerEndpoints",
	"ModuleScript types", "ModuleScript Settings", "ModuleScript DefaultSettings", "Folder Utils", "ModuleScript Debounce", "ModuleScript Log", "ModuleScript Signal"];
for (const w of want) assert.ok(items.includes(w), `missing ${w}`);
assert.equal(items.length, want.length, "no extra instances");
assert.ok(text.includes(stamp), "version stamp in the root Source");
assert.ok(text.includes("InstanceFileSyncService.GetAllInstances"), "auto-connect on Script Sync is in the vendored source");
// the server side is on: the deprecated key is the one luau-lsp reads extension defaults from (see src/studioPlugin.ts)
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(pkg.contributes.configurationDefaults["luau-lsp.plugin.enabled"], true, "luau-lsp.plugin.enabled default");
console.log(`rbxmx-check: ok — ${opens} instances, ${text.length} bytes, ${out}`);
