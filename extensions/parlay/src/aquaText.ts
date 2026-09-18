// The text side of the Aqua issues view, with no vscode import so tools/aqua-check.mjs can run it as is:
// where a Roblox error names a script and a line, which Script Sync files that instance can be on disk, and
// applying the unified diff of an Aqua patch to a file's text.

export interface Loc { path: string[]; line: number }

// A Roblox error names its script two ways. The message opens with the instance's full name and the line
// ("ServerScriptService.Shop.Buy:105: attempt to index nil with 'Price'"), and a stack frame is either
// "Script 'ServerScriptService.Shop.Buy', Line 105" (Creator Hub, ScriptContext.Error) or that same Path:105
// (debug.traceback). Aqua keeps the message and the newest stack of each error group verbatim, so both forms
// arrive here; "<player>" is Aqua's placeholder in a client path (Players.<player>.PlayerScripts.X).
const NAME = "[A-Za-z_<][\\w<>]*";
const PATH = `(?:game\\.)?${NAME}(?:\\.${NAME})+`;
const FORMS = [new RegExp(`Script '?(${PATH})'?, [Ll]ine (\\d+)`, "g"), new RegExp(`(${PATH}):(\\d+)`, "g")];

export interface Hit extends Loc { index: number; length: number }

// Every script:line named in `text`, in reading order, with where in the text it sits (for linkify).
export function locate(text: string): Hit[] {
	const hits: Hit[] = [];
	for (const re of FORMS) {
		re.lastIndex = 0;
		for (let m; (m = re.exec(text));) {
			// the frame form and the Path:line form overlap on "Script 'X', Line N"? no: one has a quote, one a colon
			if (hits.some((h) => m!.index < h.index + h.length && h.index < m!.index + m![0].length)) continue;
			hits.push({ path: normalise(m[1]), line: Number(m[2]), index: m.index, length: m[0].length });
		}
	}
	return hits.sort((a, b) => a.index - b.index);
}

// The first script:line across several texts (a message, then its stack, then the next log line...).
export function firstLoc(...texts: (string | undefined)[]): Loc | undefined {
	for (const t of texts) { const h = t ? locate(t)[0] : undefined; if (h) return { path: h.path, line: h.line }; }
	return undefined;
}

// "game." is dropped; a client script runs under the player, but lives in the Starter container Script Sync
// mirrors: Players.<name>.PlayerScripts.X -> StarterPlayer.StarterPlayerScripts.X, PlayerGui -> StarterGui,
// Backpack/StarterGear -> StarterPack. A character script (Workspace.<name>.X) has no such tell and is left alone.
function normalise(text: string): string[] {
	const parts = text.replace(/^game\./, "").split(".");
	if (parts[0] === "Players" && parts.length > 2) {
		const rest = parts.slice(3);
		if (parts[2] === "PlayerScripts") return ["StarterPlayer", "StarterPlayerScripts", ...rest];
		if (parts[2] === "PlayerGui") return ["StarterGui", ...rest];
		if (parts[2] === "Backpack" || parts[2] === "StarterGear") return ["StarterPack", ...rest];
	}
	return parts;
}

export const pathText = (loc: Loc) => loc.path.join(".");
// the last two names: enough to tell scripts apart in a list ("Shop.Buy:105")
export const shortLoc = (loc: Loc) => `${loc.path.slice(-2).join(".")}:${loc.line}`;

// Script Sync's layout: folder = container, X.server.luau a Script, X.client.luau a LocalScript, X.luau a
// ModuleScript, init.* the folder itself. The relative paths where the instance can be, most likely first.
// StarterPlayerScripts and StarterCharacterScripts are written at the top level by Script Sync, so a path
// under StarterPlayer is tried both ways.
const SUFFIXES = [".server.luau", ".client.luau", ".luau"];
export function candidates(parts: string[]): string[] {
	const roots = [parts];
	if (parts[0] === "StarterPlayer" && parts.length > 2) roots.push(parts.slice(1));
	const out: string[] = [];
	for (const p of roots) {
		const dir = p.slice(0, -1).join("/"), name = p[p.length - 1];
		const at = (file: string) => (dir ? `${dir}/${file}` : file);
		for (const s of SUFFIXES) out.push(at(`${name}${s}`));
		for (const s of SUFFIXES) out.push(at(`${name}/init${s}`));
	}
	return out;
}

// Aqua's mirror (gamesrc) uses the same layout, but writes StarterPlayer/StarterPlayerScripts nested.
export function mirrorCandidates(rel: string): string[] {
	const out = [rel];
	if (/^StarterPlayer\/Starter/.test(rel)) out.push(rel.replace(/^StarterPlayer\//, ""));
	return out;
}

// ---- HTML -------------------------------------------------------------------------------------------

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// `text` escaped, with every script:line wrapped in <a data-goto="Path|line">; the page turns those into jumps.
export function linkify(text: string): string {
	let out = "", at = 0;
	for (const h of locate(text)) {
		out += esc(text.slice(at, h.index));
		out += `<a class="goto" data-goto="${esc(pathText(h))}|${h.line}">${esc(text.slice(h.index, h.index + h.length))}</a>`;
		at = h.index + h.length;
	}
	return out + esc(text.slice(at));
}

// ---- unified diff ------------------------------------------------------------------------------------

export interface Hunk { oldStart: number; lines: string[] }   // lines keep their first column: ' ', '-', '+'
export interface FileDiff { path: string; oldPath: string; created: boolean; deleted: boolean; hunks: Hunk[] }

// `git diff` output as Aqua stores it (paths relative to the game's mirror, a/ and b/ prefixes).
export function parseDiff(diff: string): FileDiff[] {
	const files: FileDiff[] = [];
	let f: FileDiff | undefined, h: Hunk | undefined;
	for (const raw of diff.split(/\r?\n/)) {
		const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
		if (head) { f = { path: head[2], oldPath: head[1], created: false, deleted: false, hunks: [] }; files.push(f); h = undefined; continue; }
		if (!f) continue;
		if (!h && raw.startsWith("--- ")) { if (raw === "--- /dev/null") f.created = true; continue; }
		if (!h && raw.startsWith("+++ ")) { if (raw === "+++ /dev/null") f.deleted = true; continue; }
		const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
		if (hunk) { h = { oldStart: Number(hunk[1]), lines: [] }; f.hunks.push(h); continue; }
		if (h && (raw[0] === " " || raw[0] === "-" || raw[0] === "+")) h.lines.push(raw);
		else if (h && raw === "") h.lines.push(" ");   // an empty context line loses its space in some diffs
		// "\ No newline at end of file", index, mode lines: nothing to apply
	}
	return files;
}

// The patched text, or the number (1-based) of the first hunk whose old lines are not in the file. Each hunk
// is looked for at its own line first, then anywhere, so a file that moved on a little since the patch was
// drafted still takes it; one that changed under the hunk refuses it rather than guessing.
export function applyHunks(text: string, hunks: Hunk[]): string | number {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	let drift = 0;
	for (let i = 0; i < hunks.length; i++) {
		const old = hunks[i].lines.filter((l) => l[0] !== "+").map((l) => l.slice(1));
		const neu = hunks[i].lines.filter((l) => l[0] !== "-").map((l) => l.slice(1));
		const want = hunks[i].oldStart - 1 + drift;
		const fits = (p: number) => p >= 0 && p + old.length <= lines.length && old.every((l, k) => lines[p + k] === l);
		let at = -1;
		if (!old.length) at = Math.min(Math.max(want, 0), lines.length);   // a pure insertion (an empty file)
		else if (fits(want)) at = want;
		else for (let d = 1; at < 0 && d < lines.length; d++) { if (fits(want - d)) at = want - d; else if (fits(want + d)) at = want + d; }
		if (at < 0) return i + 1;
		lines.splice(at, old.length, ...neu);
		drift += neu.length - old.length;
	}
	return lines.join(eol);
}
