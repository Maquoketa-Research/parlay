// The one check: the manifest, the source, the skills and the themes agree with each other.
// Run: node tools/check.mjs   (exits 1 on the first mismatch)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// every source file: commands register wherever their feature lives (extension.ts, accounts.ts, …)
const src = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(root, "src", f), "utf8")).join("\n");
const fail = (m) => { console.error("check: " + m); process.exit(1); };

// every contributed command is registered in the source
const commands = pkg.contributes.commands.map((c) => c.command);
for (const c of commands) {
	const key = c.replace(/^parlay\.claude\./, "");
	const registered = src.includes(`"${c}"`) || (c.startsWith("parlay.claude.") && src.includes(`"${key}"`));
	if (!registered) fail(`command ${c} is contributed but never registered`);
}
// every menu entry names a contributed command
for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
	for (const it of items) if (it.command && !commands.includes(it.command)) fail(`menu ${menu} references unknown command ${it.command}`);
}
// every claude action has a skill folder with valid frontmatter, and every skill has an action
const actions = commands.filter((c) => c.startsWith("parlay.claude.")).map((c) => c.split(".").pop());
for (const a of actions) {
	const f = join(root, "skills", `parlay-${a}`, "SKILL.md");
	if (!existsSync(f)) fail(`missing skill for action ${a}: ${f}`);
	const text = readFileSync(f, "utf8");
	if (!/^---\r?\nname: parlay-[a-z-]+\r?\ndescription: .+\r?\n/m.test(text)) fail(`bad frontmatter in ${f}`);
	if (/usr\/bin\/bash|\/bin\/sh/.test(text)) fail(`shell path leaked into ${f}`);
	if (!text.includes("`$0`")) fail(`${f} never reads its target argument`);
}
for (const d of readdirSync(join(root, "skills"))) if (!actions.includes(d.replace(/^parlay-/, ""))) fail(`skill ${d} has no command`);
// every theme file exists and parses, the editor is opaque, and the default theme is one of ours
for (const t of pkg.contributes.themes) {
	const theme = JSON.parse(readFileSync(join(root, t.path), "utf8"));
	if (theme.name !== t.label) fail(`theme ${t.path} is named ${theme.name}, manifest says ${t.label}`);
	const bg = theme.colors["editor.background"];
	if (!bg) fail(`theme ${t.label} has no editor.background`);
	if (/^#[0-9A-F]{8}$/i.test(bg)) fail(`theme ${t.label}: the editor must be opaque`);
}
if (!pkg.contributes.themes.some((t) => t.label === pkg.contributes.configurationDefaults["workbench.colorTheme"])) fail("default theme is not one of ours");
// the panel views have providers
const containers = pkg.contributes.viewsContainers.secondarySidebar.map((c) => c.id);
for (const [container, views] of Object.entries(pkg.contributes.views)) {
	if (!containers.includes(container)) fail(`views for ${container}, but no such secondary sidebar container`);
	for (const v of views) if (!src.includes(`"${v.id}"`)) fail(`view ${v.id} has no provider`);
}
for (const c of pkg.contributes.viewsContainers.secondarySidebar) if (!existsSync(join(root, c.icon))) fail(`container ${c.id}: icon ${c.icon} missing`);

console.log(`check: ok — ${commands.length} commands, ${actions.length} skills, ${pkg.contributes.themes.length} themes`);
