// A Roblox XML model (.rbxmx) from a Rojo-style source folder: what `rojo build` makes of a project whose tree
// is {"$path": "src"} (https://rojo.space/docs/v7/sync-details/). A folder is a Folder, X.luau a ModuleScript,
// X.server.luau a Script, X.client.luau a LocalScript, and init.*.luau makes the folder itself that script with
// the folder's other entries as its children. Format per https://dom.rojo.space/xml.html: one
// <roblox version="4"> root, nested <Item class referent> each with <Properties>, Source as a CDATA
// ProtectedString, referents unique in the file. Pure fs, no vscode: tools/rbxmx-check.mjs runs it under node.
import * as fs from "fs";
import * as path from "path";

const CLASS: Record<string, string> = { server: "Script", client: "LocalScript", "": "ModuleScript" };

function scriptOf(file: string): { name: string; className: string } | undefined {
	const m = /^(.*?)(?:\.(server|client))?\.luau?$/i.exec(file);
	return m ? { name: m[1], className: CLASS[(m[2] ?? "").toLowerCase()] } : undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

// rootName: the project name Rojo gives the top instance. rootSuffix: appended to the root script's Source
// (a trailing Luau comment carries the version stamp; line numbers stay put).
export function buildRbxmx(srcDir: string, rootName: string, rootSuffix = ""): string {
	let n = 0;
	const wrap = (className: string, name: string, source: string | undefined, children: string) =>
		`\n<Item class="${className}" referent="RBX${n++}"><Properties><string name="Name">${esc(name)}</string>` +
		(source === undefined ? "" : `<ProtectedString name="Source">${cdata(source)}</ProtectedString>`) +
		`</Properties>${children}</Item>`;
	const item = (dir: string, name: string, suffix: string): string => {
		let className = "Folder", source: string | undefined, children = "";
		// sorted: readdir order is filesystem-dependent and the installer compares the whole file
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) { children += item(full, e.name, ""); continue; }
			const s = scriptOf(e.name);
			if (!s) continue;
			if (s.name === "init") { className = s.className; source = fs.readFileSync(full, "utf8") + suffix; }
			else children += wrap(s.className, s.name, fs.readFileSync(full, "utf8"), "");
		}
		return wrap(className, name, source, children);
	};
	return `<roblox version="4">${item(srcDir, rootName, rootSuffix)}\n</roblox>\n`;
}
