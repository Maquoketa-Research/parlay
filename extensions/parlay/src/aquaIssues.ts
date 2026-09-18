// The Aqua issues view: one row per issue Aqua holds against the game this folder is the Script Sync of. A click
// opens the script at the line Roblox named; the panel under the list shows why (message, stack, reports, the
// verifier's verdict, metrics, Aqua's patch) with the actions: Apply fix, Fix with Claude, Open in Aqua, Dismiss.
//
// Aqua's API as read from its code (docs/aqua.md): GET /api/games lists the games with place_id and places[];
// GET /api/state?game=<slug> carries the issues (each with the verifier's evidence JSON: reporting, server_logs[],
// analytics, reasoning) and patch summaries; GET /api/issues/<id>/messages the reports; GET /api/patches/<id> the
// diff; POST /api/issues/<id>/dismiss; GET /api/events is an SSE stream of topics (issue, patch, job...) that
// says when to re-read. An issue names a script the way Roblox does, in the error text (aquaText.ts).
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { api, aquaIsLocal, aquaSignIn, aquaUrl, detail, Game, gameForPlace, sessionHeaders } from "./aqua";
import { applyHunks, candidates, esc, firstLoc, linkify, Loc, mirrorCandidates, parseDiff, pathText, shortLoc } from "./aquaText";
import { listStudiosViaWindows, log, readSyncRecord, syncRecordName } from "./studio";

// ---- Aqua's shapes (db/rows.py Issue and Patch, verify.py gather()) ------------------------------

interface Issue { id: number; title: string; summary: string; severity: string; status: string; kind: string; area: string; report_count: number; reporter_count: number; created_at: number; updated_at: number; verdict_state: string; confidence: string; evidence: string; sources?: string[]; blocked_on: string }
interface LogLine { job_id: string; severity: string; message: string; stack: string; ts: number; side: string; count: number; servers: number; place_id?: string; first_version?: string }
interface Metric { metric: string; during_reports: number; week_before: number; change_percent: number }
interface Evidence { reporting?: { reports: number; distinct_players: number; distinct_servers: number; first_ts: number; last_ts: number }; server_logs?: LogLine[]; analytics?: Metric[]; reasoning?: string }
interface PatchSummary { id: number; issue_id: number; status: string; title: string; files: string[]; fix_summary: string; root_cause: string; created_at: number; also_fixes?: number[] }
interface Patch extends PatchSummary { diff: string }
interface Message { source: string; author: string | null; content: string; ts: number; channel?: string | null; confidence?: string }

interface Row { issue: Issue; ev: Evidence; loc?: Loc; count: number; patch?: PatchSummary }

type State = "loading" | "noGame" | "unreachable" | "signIn" | "empty" | "ok";
const SEVERITY = ["critical", "high", "medium", "low"];
const LIVE = new Set(["open", "investigating", "patched"]);
const PATCH_ORDER = ["pending", "queued", "approved", "applied", "failed"];   // the one to show, in this order; denied ones are not offered

// What the view needs from the panel next to it (extension.ts UrlView) and from the agent terminal.
export interface Panel { showEvidence(body: string): void; showLanding(): void; showDashboard(): void; fix(line: string): Promise<void> }

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const when = (ts?: number) => ts ? new Date(ts * 1000).toLocaleString() : "";
const clean = (s: string) => s.replace(/["\r\n]/g, "'");
const parseEv = (text: string): Evidence => { try { return JSON.parse(text || "{}"); } catch { return {}; } };

class AquaIssues implements vscode.TreeDataProvider<Row> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	rows: Row[] = [];
	state: State = "loading";
	game?: Game;
	selected?: Row;
	private shown?: "issues" | "landing";   // what the panel was last told to show, so a refresh does not flip it
	private loading?: Promise<void>;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly panel: Panel, private readonly status: vscode.StatusBarItem) {}

	getChildren() { return this.rows; }
	getTreeItem(r: Row): vscode.TreeItem {
		const t = new vscode.TreeItem(r.issue.title, vscode.TreeItemCollapsibleState.None);
		t.id = String(r.issue.id);
		t.description = [r.loc ? shortLoc(r.loc) : r.issue.area, r.count > 1 ? `×${r.count}` : ""].filter(Boolean).join(" · ");
		t.iconPath = icon(r.issue.severity);
		t.tooltip = tooltip(r, this.game);
		t.command = { command: "parlay.aqua.open", title: "Open", arguments: [r] };
		return t;
	}

	private set(state: State) {
		this.state = state;
		void vscode.commands.executeCommand("setContext", "parlay.aqua.state", state);
		this.changed.fire();
		const known = state === "ok" || state === "empty";
		if (known && this.game) {
			const n = this.rows.length;
			this.status.text = `$(bug) Aqua ${n}`;
			this.status.tooltip = `${n} open issue${n === 1 ? "" : "s"} in ${this.game.name}. Click to open the list.`;
			this.status.show();
		} else this.status.hide();
		// the panel: evidence next to a known game's issues, the pairing page otherwise (only when that changes)
		const want = known ? "issues" : "landing";
		if (want !== this.shown) { this.shown = want; if (want === "issues") this.panel.showEvidence(this.selected ? "" : placeholder(this.game)); else this.panel.showLanding(); }
		if (want === "issues" && this.selected) void this.open(this.selected, false);   // re-drawn from the fresh state
	}

	load(): Promise<void> { return this.loading ??= this.doLoad().finally(() => { this.loading = undefined; }); }

	private async doLoad() {
		if (!root()) { this.rows = []; this.set("noGame"); return; }
		const placeId = await this.placeId();
		const r = await api("GET", "/api/games");
		if (r.status === 401) { this.set("signIn"); return; }
		if (!r.ok) { this.set("unreachable"); return; }
		const game = placeId ? gameForPlace(r.data.games ?? [], placeId) : undefined;
		if (!game) { log.appendLine(`Aqua issues: no game for place ${placeId ?? "(unknown)"} among ${(r.data.games ?? []).length} game(s)`); this.rows = []; this.set("noGame"); return; }
		this.game = game;
		const s = await api("GET", `/api/state?game=${encodeURIComponent(game.slug)}`);
		if (!s.ok) { this.set(s.status === 401 ? "signIn" : "unreachable"); return; }
		const patches: PatchSummary[] = s.data.patches ?? [];
		this.rows = ((s.data.issues ?? []) as Issue[]).filter((i) => i.kind === "bug" && LIVE.has(i.status)).map((i) => row(i, patches))
			.sort((a, b) => SEVERITY.indexOf(a.issue.severity) - SEVERITY.indexOf(b.issue.severity) || b.issue.updated_at - a.issue.updated_at);
		if (this.selected) {
			this.selected = this.rows.find((x) => x.issue.id === this.selected!.issue.id);
			if (!this.selected) this.panel.showEvidence(placeholder(game));   // resolved or dismissed since: nothing to show for it
		}
		this.set(this.rows.length ? "ok" : "empty");
	}

	// Which Roblox place this folder is: the record Add Roblox Studio project wrote for it, else Studio's own
	// Script Sync record of an open place that names this folder. Remembered per workspace once found; a miss
	// (PowerShell probes) is not repeated for five minutes, or until Refresh.
	private missedAt = 0;
	forget() { this.missedAt = 0; return this.ctx.workspaceState.update("aquaPlaceId", undefined); }
	private async placeId(): Promise<string | undefined> {
		const ws = root()!;
		const cached = this.ctx.workspaceState.get<string>("aquaPlaceId");
		if (cached) return cached;
		if (Date.now() - this.missedAt < 5 * 60_000) return undefined;
		const same = (a: string, b: string) => path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
		let found: string | undefined;
		for (const k of this.ctx.globalState.keys()) {
			if (!k.startsWith("studioProject:")) continue;
			const v = this.ctx.globalState.get<{ folder: string; placeId: string }>(k);
			if (v?.placeId && same(v.folder, ws)) { found = v.placeId; break; }
		}
		if (!found) for (const s of await listStudiosViaWindows().catch(() => [])) {
			if (!s.placeId) continue;
			const rec = await syncRecordName(s.placeId);
			if (rec && (await readSyncRecord(rec)).some((e) => same(path.dirname(e.filePath.replace(/\//g, "\\")), ws))) { found = s.placeId; break; }
		}
		if (found) await this.ctx.workspaceState.update("aquaPlaceId", found); else this.missedAt = Date.now();
		return found;
	}

	// The click: the script at the line, selected and centred, then the evidence beside it.
	async open(r: Row, jump = true) {
		this.selected = r;
		const file = r.loc ? await resolveFile(r.loc) : undefined;
		if (file && jump) await reveal(file, r.loc!.line);
		const [msgs, patch] = await Promise.all([
			api("GET", `/api/issues/${r.issue.id}/messages`),
			r.patch ? api("GET", `/api/patches/${r.patch.id}`) : Promise.resolve(undefined),
		]);
		this.panel.showEvidence(evidenceHtml(r, file, this.game, msgs.ok ? msgs.data.messages ?? [] : [], patch?.ok ? patch.data as Patch : undefined));
	}

	// Aqua's patch onto the Script Sync files, one undoable edit per file, saved so Studio takes it at once.
	async applyFix(patchId: number) {
		const ws = root(); if (!ws) return;
		const r = await api("GET", `/api/patches/${patchId}`);
		if (!r.ok) { fail(`Aqua did not hand over patch #${patchId}: ${detail(r)}`); return; }
		const files = parseDiff(String(r.data.diff ?? ""));
		if (!files.length) { fail(`Patch #${patchId} carries no diff.`); return; }
		const edit = new vscode.WorkspaceEdit();
		const touched: vscode.Uri[] = [];
		for (const f of files) {
			if (f.deleted) { const u = await mirrorFile(f.oldPath); if (u) edit.deleteFile(u); continue; }
			const u = f.created ? vscode.Uri.file(path.join(ws, ...f.path.split("/"))) : await mirrorFile(f.path);
			if (!u) { fail(`${f.path} is not in this folder, so the patch cannot be applied here. Open it in Aqua and let the Studio plugin apply it.`); return; }
			const doc = f.created ? undefined : await vscode.workspace.openTextDocument(u);
			const out = applyHunks(doc?.getText() ?? "", f.hunks);
			if (typeof out === "number") { fail(`Hunk ${out} of ${f.path} does not fit the file as it is now: the script changed since Aqua drafted the patch. Fix with Claude instead, or redraft in Aqua.`); return; }
			if (doc) {
				// shown first so the edit lands on a live undo stack: Ctrl+Z in the editor takes it back
				await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
				edit.replace(u, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), out);
			} else { edit.createFile(u, { overwrite: false }); edit.insert(u, new vscode.Position(0, 0), out); }
			touched.push(u);
		}
		if (!(await vscode.workspace.applyEdit(edit))) { fail("The editor refused the edit."); return; }
		for (const u of touched) await (await vscode.workspace.openTextDocument(u)).save();   // Script Sync ships saved files to Studio
		log.appendLine(`applied Aqua patch #${patchId} to ${touched.map((u) => vscode.workspace.asRelativePath(u)).join(", ")}`);
		void vscode.window.showInformationMessage(`Applied Aqua's patch #${patchId} to ${touched.length} file${touched.length === 1 ? "" : "s"}; Studio has it through Script Sync. Ctrl+Z in the editor undoes it.`);
	}

	// /parlay-fix on the line, with Aqua's evidence as the brief (extension.ts runSkill sends the same shape).
	async fixWithClaude(issueId: number) {
		const r = this.rows.find((x) => x.issue.id === issueId) ?? this.selected;
		if (!r?.loc) { fail("Aqua's reports name no script and line for this issue, so there is nothing to point Claude at."); return; }
		const file = await resolveFile(r.loc);
		if (!file) { fail(`${pathText(r.loc)} is not in this folder (Workspace scripts are not synced).`); return; }
		const rel = vscode.workspace.asRelativePath(file, false).replace(/\\/g, "/");
		const first = r.ev.server_logs?.[0];
		const why = [`Aqua issue #${r.issue.id} (${r.issue.severity}): ${r.issue.title}.`, first?.message, r.count > 1 ? `Seen ×${r.count}.` : "", r.ev.reasoning].filter(Boolean).join(" ");
		await this.panel.fix(`/parlay-fix ${rel}:${r.loc.line}-${r.loc.line} ${clean(why).slice(0, 500)}`);
	}

	async dismiss(issueId: number) {
		const r = this.rows.find((x) => x.issue.id === issueId);
		const go = await vscode.window.showWarningMessage(`Dismiss "${r?.issue.title ?? `issue #${issueId}`}" in Aqua?`, { modal: true, detail: "Aqua sets it aside; new reports still attach to it, and enough of them reopen it. Reopen is one click in Aqua." }, "Dismiss");
		if (!go) return;
		const res = await api("POST", `/api/issues/${issueId}/dismiss`, { note: "handled in Parlay" });
		if (!res.ok) { fail(`Aqua refused: ${detail(res)}`); return; }
		if (this.selected?.issue.id === issueId) { this.selected = undefined; this.panel.showEvidence(placeholder(this.game)); }
		void this.load();
	}
}

// ---- rows -----------------------------------------------------------------------------------------

function row(i: Issue, patches: PatchSummary[]): Row {
	const ev = parseEv(i.evidence);
	const logs = ev.server_logs ?? [];
	// the script and line: the verifier's log lines first (message, then stack), then the triage text
	const loc = firstLoc(...logs.flatMap((l) => [l.message, l.stack]), i.title, i.summary);
	const count = Math.max(i.report_count || 0, ...logs.map((l) => l.count || 0));
	const patch = patches.filter((p) => (p.issue_id === i.id || (p.also_fixes ?? []).includes(i.id)) && PATCH_ORDER.includes(p.status))
		.sort((a, b) => PATCH_ORDER.indexOf(a.status) - PATCH_ORDER.indexOf(b.status) || b.created_at - a.created_at)[0];
	return { issue: i, ev, loc, count, patch };
}

function icon(severity: string): vscode.ThemeIcon {
	switch (severity) {
		case "critical": return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
		case "high": return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
		case "medium": return new vscode.ThemeIcon("info", new vscode.ThemeColor("problemsInfoIcon.foreground"));
		default: return new vscode.ThemeIcon("circle-outline");
	}
}

// Where it was seen: the places the log lines name, else the game's own place; named when Aqua knows the name.
function places(r: Row, game?: Game): string[] {
	const ids = new Set((r.ev.server_logs ?? []).map((l) => l.place_id).filter((p): p is string => !!p));
	if (!ids.size && game?.place_id) ids.add(game.place_id);
	return Array.from(ids, (id) => game?.places?.find((p) => p.place_id === id)?.name || `place ${id}`);
}

function tooltip(r: Row, game?: Game): vscode.MarkdownString {
	const rep = r.ev.reporting;
	const md = new vscode.MarkdownString();
	md.appendMarkdown(`**${r.issue.title}**  \n${r.issue.severity} · ${r.issue.status}${r.issue.verdict_state ? ` · ${r.issue.verdict_state}` : ""}\n\n`);
	if (r.loc) md.appendMarkdown(`\`${pathText(r.loc)}:${r.loc.line}\`\n\n`);
	md.appendMarkdown(`First seen ${when(rep?.first_ts || r.issue.created_at)}  \nLast seen ${when(rep?.last_ts || r.issue.updated_at)}  \nSeen in ${places(r, game).join(", ")}`);
	if (r.issue.sources?.length) md.appendMarkdown(`  \nFrom ${r.issue.sources.join(", ")}`);
	return md;
}

// ---- files ----------------------------------------------------------------------------------------

// The Script Sync file for an instance path: the layout rules first, then the name anywhere in the folder.
async function resolveFile(loc: Loc): Promise<vscode.Uri | undefined> {
	const ws = root(); if (!ws) return undefined;
	for (const rel of candidates(loc.path)) { const p = path.join(ws, ...rel.split("/")); if (fs.existsSync(p)) return vscode.Uri.file(p); }
	const name = loc.path[loc.path.length - 1];
	const found = await vscode.workspace.findFiles(`**/{${name}.server.luau,${name}.client.luau,${name}.luau,${name}/init.server.luau,${name}/init.client.luau,${name}/init.luau}`, "**/node_modules/**", 2);
	return found[0];
}

// A path from Aqua's mirror (the same layout; StarterPlayer nested there, flat here), else its basename anywhere.
async function mirrorFile(rel: string): Promise<vscode.Uri | undefined> {
	const ws = root(); if (!ws) return undefined;
	for (const c of mirrorCandidates(rel)) { const p = path.join(ws, ...c.split("/")); if (fs.existsSync(p)) return vscode.Uri.file(p); }
	return (await vscode.workspace.findFiles(`**/${path.posix.basename(rel)}`, "**/node_modules/**", 2))[0];
}

async function reveal(uri: vscode.Uri, line: number) {
	const doc = await vscode.workspace.openTextDocument(uri);
	const range = doc.lineAt(Math.min(Math.max(line, 1), doc.lineCount) - 1).range;
	const ed = await vscode.window.showTextDocument(doc, { selection: range });
	ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

const fail = (m: string) => { log.appendLine(`Aqua issues: ${m}`); void vscode.window.showWarningMessage(`Parlay: ${m}`); };

// ---- the evidence page ----------------------------------------------------------------------------

const CSS = `<style>
body{margin:0;padding:10px 12px 24px;font:12px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:transparent}
h2{font-size:14px;font-weight:600;margin:6px 0 4px}h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px;color:var(--vscode-descriptionForeground)}
p{margin:0 0 6px}.dim{color:var(--vscode-descriptionForeground)}.mono{font-family:var(--vscode-editor-font-family);font-size:11px}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;margin-right:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.sev-critical{background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground)}.sev-high{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-editorWarning-foreground)}
.loc{margin:4px 0 6px}.warn{color:var(--vscode-editorWarning-foreground)}
a.goto{color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer;font-family:var(--vscode-editor-font-family)}a.goto:hover{text-decoration:underline}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}
button{padding:5px 14px;border:0;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}
button.alt{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.alt:hover{background:var(--vscode-button-secondaryHoverBackground)}
pre{margin:4px 0 8px;padding:8px 10px;border-radius:6px;overflow:auto;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.45;white-space:pre-wrap}
.log{margin:0 0 10px}.log .msg{font-family:var(--vscode-editor-font-family);font-size:11px;margin:2px 0}
blockquote{margin:0 0 8px;padding:4px 10px;border-left:2px solid var(--vscode-panel-border)}
.add{color:var(--vscode-gitDecoration-addedResourceForeground)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground)}.hunk{color:var(--vscode-descriptionForeground)}
ul{margin:0;padding-left:18px}.empty{height:80vh;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--vscode-descriptionForeground)}
</style>`;

const btn = (cmd: string, label: string, args: unknown[] = [], alt = false) => `<button class="${alt ? "alt" : ""}" data-cmd="${cmd}" data-args="${esc(JSON.stringify(args))}">${label}</button>`;

export function placeholder(game?: Game): string {
	return `${CSS}<div class="empty"><div>${game ? `Aqua watches <b>${esc(game.name)}</b>.<br>Select an issue to see its evidence here.` : "Select an issue to see its evidence here."}<br><br>${btn("parlay.aqua.landing", "Pairing page", [], true)}</div></div>`;
}

function evidenceHtml(r: Row, file: vscode.Uri | undefined, game: Game | undefined, messages: Message[], patch?: Patch): string {
	const i = r.issue, ev = r.ev, logs = ev.server_logs ?? [], rep = ev.reporting;
	const rel = file ? vscode.workspace.asRelativePath(file, false).replace(/\\/g, "/") : "";
	const where = !r.loc ? `<div class="loc dim">Aqua's reports name no script and line; the summary and reports below say where to look.</div>`
		: file ? `<div class="loc"><a class="goto" data-goto="${esc(pathText(r.loc))}|${r.loc.line}">${esc(pathText(r.loc))}:${r.loc.line}</a> <span class="dim">· ${esc(rel)}</span></div>`
			: `<div class="loc warn">${esc(pathText(r.loc))}:${r.loc.line} is not in this folder. Script Sync only mirrors the script containers (Workspace scripts, for one, are not synced): find it in Studio's Explorer at that path, or sync its container into this folder.</div>`;
	const facts = [
		logs.length ? `×${r.count} error${r.count === 1 ? "" : "s"} on ${Math.max(...logs.map((l) => l.servers || 1))} server${logs.some((l) => l.servers > 1) ? "s" : ""}` : `×${r.count} report${r.count === 1 ? "" : "s"}`,
		rep?.distinct_players ? `${rep.distinct_players} player${rep.distinct_players === 1 ? "" : "s"} reporting` : "",
		`first seen ${when(rep?.first_ts || i.created_at)}`, `last ${when(rep?.last_ts || i.updated_at)}`,
		`seen in ${places(r, game).join(", ")}`,
		logs.find((l) => l.first_version) ? `first on place version ${logs.find((l) => l.first_version)!.first_version}` : "",
	].filter(Boolean).join(" · ");
	const actions = [
		patch?.diff ? btn("parlay.aqua.applyFix", `Apply fix${patch.status !== "pending" ? ` (${patch.status})` : ""}`, [patch.id]) : "",
		file && r.loc ? btn("parlay.aqua.fixWithClaude", "Fix with Claude", [i.id]) : "",
		btn("parlay.aqua.openInAqua", "Open in Aqua", [], true),
		btn("parlay.aqua.dismiss", "Dismiss", [i.id], true),
	].join("");
	const verdict = i.verdict_state
		? `<p><b>${esc(i.verdict_state)}</b> with ${esc(i.confidence)} confidence. ${esc(ev.reasoning ?? "")}</p>`
		: `<p class="dim">Not verified yet; Aqua checks the logs and analytics before it drafts a fix.</p>`;
	const logHtml = logs.slice(0, 12).map((l) => `<div class="log"><span class="dim">[${esc(l.severity)}] ${esc(l.side || "server")} ${esc(String(l.job_id || "").slice(0, 8))}${l.count > 1 ? ` ×${l.count} on ${l.servers || 1} server${l.servers > 1 ? "s" : ""}` : ""}${l.place_id ? ` · place ${esc(l.place_id)}` : ""} · ${esc(when(l.ts))}</span><div class="msg">${linkify(l.message)}</div>${l.stack ? `<pre>${l.stack.split("\n").filter((f) => f.trim()).slice(0, 8).map((f) => linkify(f.trim())).join("\n")}</pre>` : ""}</div>`).join("");
	const quotes = messages.filter((m) => m.confidence !== "low").slice(0, 10).map((m) => `<blockquote><b>${esc(m.author || m.source)}</b> <span class="dim">· ${esc(m.source)}${m.channel ? ` · ${esc(m.channel)}` : ""} · ${esc(when(m.ts))}</span><br><span class="mono">${linkify(m.content.slice(0, 600))}</span></blockquote>`).join("");
	const metrics = (ev.analytics ?? []).map((m) => `<li>${esc(m.metric)}: ${esc(m.during_reports)} vs ${esc(m.week_before)} (${m.change_percent >= 0 ? "+" : ""}${Number(m.change_percent || 0).toFixed(1)}%)</li>`).join("");
	const diff = patch?.diff ? patch.diff.split("\n").map((l) => `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l)}</span>`).join("\n") : "";
	return `${CSS}
<div><span class="tag sev-${esc(i.severity)}">${esc(i.severity)}</span><span class="tag">${esc(i.status)}</span><span class="dim">#${i.id}${i.area ? ` · ${esc(i.area)}` : ""}${i.blocked_on ? ` · blocked: ${esc(i.blocked_on)}` : ""}</span></div>
<h2>${esc(i.title)}</h2>
${where}
<div class="dim">${esc(facts)}</div>
<div class="actions">${actions}</div>
<p>${linkify(i.summary)}</p>
<h3>Why Aqua thinks so</h3>${verdict}
${logs.length ? `<h3>Errors from the servers (${logs.length} line${logs.length === 1 ? "" : "s"})</h3>${logHtml}` : ""}
${quotes ? `<h3>Reports (${messages.length})</h3>${quotes}` : ""}
${metrics ? `<h3>Metrics during the reports vs the week before</h3><ul>${metrics}</ul>` : ""}
${patch ? `<h3>Aqua's fix · ${esc(patch.status)}</h3><p><b>${esc(patch.title)}</b></p>${patch.root_cause ? `<p>${esc(patch.root_cause)}</p>` : ""}${patch.fix_summary ? `<p>${esc(patch.fix_summary)}</p>` : ""}${diff ? `<pre>${diff}</pre>` : `<p class="dim">The patch has no diff to show.</p>`}` : r.issue.status === "investigating" ? `<h3>Aqua's fix</h3><p class="dim">An agent is drafting one now.</p>` : ""}`;
}

// ---- live -----------------------------------------------------------------------------------------

// Aqua's SSE stream while the list is visible: each frame is a topic, and issue/patch/job mean re-read. When the
// stream cannot be opened (down, or a 401 before the session exists) the list is re-read every 30 s instead.
async function watch(bump: () => void, signal: AbortSignal) {
	const dec = new TextDecoder();
	while (!signal.aborted) {
		try {
			const r = await fetch(`${aquaUrl()}/api/events`, { headers: await sessionHeaders(), signal });
			if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}`);
			const reader = r.body.getReader();
			let buf = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const topic = /^event: (\w+)/m.exec(buf.slice(0, i))?.[1];
					buf = buf.slice(i + 2);
					if (topic === "issue" || topic === "patch" || topic === "job") bump();
				}
			}
		} catch { /* fall through to the wait */ }
		if (signal.aborted) return;
		await new Promise((res) => { const t = setTimeout(res, 30_000); signal.addEventListener("abort", () => { clearTimeout(t); res(undefined); }, { once: true }); });
		bump();
	}
}

// ---- registration ---------------------------------------------------------------------------------

export function registerAquaIssues(ctx: vscode.ExtensionContext, panel: Panel) {
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	status.command = "parlay.aqua.issues.focus";
	const issues = new AquaIssues(ctx, panel, status);
	const tree = vscode.window.createTreeView("parlay.aqua.issues", { treeDataProvider: issues });
	let debounce: NodeJS.Timeout | undefined;
	const bump = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => void issues.load(), 1500); };
	let watching: AbortController | undefined;
	const live = () => {
		if (tree.visible && !watching) { watching = new AbortController(); void watch(bump, watching.signal); }
		if (!tree.visible && watching) { watching.abort(); watching = undefined; }
	};
	ctx.subscriptions.push(
		status, tree,
		tree.onDidChangeVisibility(live),
		vscode.commands.registerCommand("parlay.aqua.open", (r: Row) => issues.open(r)),
		vscode.commands.registerCommand("parlay.aqua.goto", async (p: string, line: number) => {
			const loc = { path: p.split("."), line };
			const file = await resolveFile(loc);
			if (file) await reveal(file, line); else fail(`${p} is not in this folder (Script Sync only mirrors the script containers).`);
		}),
		vscode.commands.registerCommand("parlay.aqua.applyFix", (id: number) => issues.applyFix(id)),
		vscode.commands.registerCommand("parlay.aqua.fixWithClaude", (id: number) => issues.fixWithClaude(id)),
		vscode.commands.registerCommand("parlay.aqua.dismiss", (id: number) => issues.dismiss(id)),
		// no per-issue link exists on the dashboard; ?game= opens the game's issues screen (its default)
		vscode.commands.registerCommand("parlay.aqua.openInAqua", () => vscode.env.openExternal(vscode.Uri.parse(`${aquaUrl()}/?game=${encodeURIComponent(issues.game?.slug ?? "")}`))),
		vscode.commands.registerCommand("parlay.aqua.refresh", async () => { await issues.forget(); await issues.load(); }),
		vscode.commands.registerCommand("parlay.aqua.landing", () => panel.showLanding()),
		// docs/aqua.md proposal A; until Aqua has it, the dashboard's own sign-in and a plain explanation
		vscode.commands.registerCommand("parlay.aqua.signIn", async () => {
			if (aquaIsLocal()) { void vscode.window.showInformationMessage("The local Aqua has no sign-in; every caller is its operator."); await issues.load(); return; }
			if (await aquaSignIn(false)) { await issues.load(); return; }
			panel.showDashboard();
			void vscode.window.showInformationMessage("This Aqua has no token exchange for Parlay yet (POST /api/auth/token, docs/aqua.md), so the issue list cannot load here. The dashboard in the panel takes its own sign-in and shows the same issues; the list fills in the day Aqua adds the route.", { modal: false });
		}),
		vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("parlay.aquaUrl")) bump(); }),
	);
	void vscode.commands.executeCommand("setContext", "parlay.aqua.state", "loading");
	void issues.load().then(live);
}
