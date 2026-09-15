// Copy the parts of three.js the Meshy webview imports into media/three (the .vsix carries media, not
// node_modules). Follows relative imports so the addons' helpers come along. Runs before tsc (npm run compile).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "node_modules", "three");
const out = path.join(root, "media", "three");
const wanted = ["build/three.module.js", "examples/jsm/loaders/GLTFLoader.js", "examples/jsm/exporters/GLTFExporter.js", "examples/jsm/controls/OrbitControls.js"];

const seen = new Set();
function copy(rel) {
	if (seen.has(rel)) return;
	seen.add(rel);
	const from = path.join(src, rel);
	const to = path.join(out, rel.replace(/^build\//, "").replace(/^examples\/jsm\//, "jsm/"));
	fs.mkdirSync(path.dirname(to), { recursive: true });
	const text = fs.readFileSync(from, "utf8");
	fs.writeFileSync(to, text);
	for (const m of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) copy(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
}
wanted.forEach(copy);
console.log(`vendored ${seen.size} three.js files into media/three`);
