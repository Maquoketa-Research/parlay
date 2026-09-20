// Parlay: QA. The play runner (qa/play.mjs) from inside the editor. The view takes an open Studio place (or a
// place id the runner opens itself), minutes and the policy (Jev when a TypeSafe key is stored, else scripted);
// Run spawns the runner as a node child writing <globalStorage>/qa/<timestamp>/. The view tails its
// stepsLog.jsonl and shows each step as it lands (action, outcome, new console lines, error count, the screenshot
// when there is one), then the findings with Open in editor and Fix with Claude, and report.md rendered. Stop
// creates the runner's --stop-file (it stops Play on its way out) and kills the process tree if it is still there
// after 30 s. Previous runs list from the same folder. Also here: the TypeSafe key and the Aqua ingest key
// (SecretStorage; the Accounts page shows both and runs the same commands).
import * as vscode from "vscode";
import { ChildProcess, execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aquaUrl } from "./aqua";
import { resolveFile, reveal } from "./aquaIssues";
import { esc, firstLoc, pathText } from "./aquaText";
import { log } from "./log";
import { listStudios } from "./studio";

export const TYPESAFE_KEY = "parlay.typesafeApiKey";
export const AQUA_INGEST_KEY = "parlay.aquaIngestKey";
export const TYPESAFE_KEY_FILE = path.join(os.homedir(), ".parlay", "typesafe-api-key");   // the runner's second source

// ---- the runner's shapes (qa/play.mjs report.json and stepsLog.jsonl) ---------------------------------------
interface Action { kind: string; path?: string; text?: string; class?: string; key?: string; jev?: { flags: { looksWrong: number } } }
interface Hist { step: number; action: Action; result?: string }
interface Finding { message: string; side: string; count: number; firstStep: number; lastStep: number; trace: string[]; screenshot?: string; actionsBefore: Hist[] }
interface Suspect { step: number; probability: number; screenshot?: string; console: string[]; actionsBefore: Hist[] }
interface Report { place: string; studio?: { name: string }; policy?: string; start: string; end?: string; steps: number; errors: Finding[]; stuck: { step: number; state?: string }[]; suspects?: Suspect[]; exitCode: number; failure?: string; aqua?: string }
interface Form { place: string; minutes: number; policy: "" | "scripted" | "jev" }

const describe = (a: Action) => a.kind === "click" ? `click ${a.text ?? ""}` : a.kind === "interact" ? `${a.class} ${a.path?.split(".").pop()}` : `walk ${a.key}`;
const before = (h: Hist) => `${h.step}: ${describe(h.action)}${h.result ? ` → ${h.result}` : ""}`;
const placeName = (r: Report) => r.studio?.name?.replace(/\s*\(placeId:.*\)$/, "") || `place ${r.place}`;
const clean = (s: string) => s.replace(/["\r\n]/g, "'");
const warn = (m: string) => { log.warn(`QA: ${m}`); void vscode.window.showWarningMessage(`Parlay QA: ${m}`); };
const defaultForm = (): Form => ({ place: "", minutes: 5, policy: "" });

class QaView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private child?: ChildProcess;
	private out?: string;          // the folder of the running, or last shown, run
	private report?: Report;       // its report once written: the findings' buttons work from it
	private studios: { name: string; placeId: string }[] = [];
	private tail?: NodeJS.Timeout;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly fix: (line: string) => Promise<void>) {}

	private dir() { return path.join(this.ctx.globalStorageUri.fsPath, "qa"); }
	private post(m: unknown) { void this.view?.webview.postMessage(m); }
	private uri(file: string) { return this.view?.webview.asWebviewUri(vscode.Uri.file(file)).toString(); }
	// a screenshot the runner managed to save (a failed capture is recorded as text)
	private shot(out: string, file?: string) { return file && !file.startsWith("failed") && !file.endsWith(".txt") ? this.uri(path.join(out, file)) : undefined; }

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		fs.mkdirSync(this.dir(), { recursive: true });
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.dir()), vscode.Uri.joinPath(this.ctx.extensionUri, "media")] };
		view.webview.html = html(view.webview.cspSource, view.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "qa.js")).toString());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		view.webview.onDidReceiveMessage((m: any) => void this.onMessage(m));
		view.onDidDispose(() => { this.view = undefined; });
		void this.init();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async onMessage(m: any) {
		switch (m?.type) {
			case "run": { const form: Form = { place: String(m.place ?? "").trim(), minutes: Number(m.minutes) || 5, policy: m.policy === "jev" ? "jev" : "scripted" }; await this.ctx.globalState.update("qaForm", form); await this.run(form); break; }
			case "stop": this.stop(); break;
			case "refresh": await this.init(true); break;
			case "setKey": await vscode.commands.executeCommand("parlay.typesafe.setKey"); break;
			case "show": this.show(path.join(this.dir(), path.basename(String(m.name)))); break;
			case "goto": { const hit = await this.locate(Number(m.i)); if (hit) await reveal(hit.file, hit.line); break; }
			case "fix": await this.fixWithClaude(Number(m.i)); break;
			case "md": if (this.out) await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(path.join(this.out, "report.md"))); break;
		}
	}

	// The form, the open Studio places (not re-listed while the runner holds the MCP seat), the key, the runs.
	async init(fresh = false) {
		if (!this.view) return;
		if ((fresh || !this.studios.length) && !this.child) this.studios = (await listStudios().catch(() => [])).filter((s) => s.placeId).map((s) => ({ name: s.name, placeId: s.placeId }));
		const hasKey = !!(await this.ctx.secrets.get(TYPESAFE_KEY)) || fs.existsSync(TYPESAFE_KEY_FILE);
		const form = this.ctx.globalState.get<Form>("qaForm", defaultForm());
		this.post({ type: "init", studios: this.studios, form: { ...form, policy: hasKey ? form.policy || "jev" : "scripted" }, hasKey, running: !!this.child, runs: this.runs() });
	}

	// The palette's Run: the remembered form, with a place picked from the open Studios when none is remembered.
	async runCommand() {
		await vscode.commands.executeCommand("parlay.qa.focus");
		const form = this.ctx.globalState.get<Form>("qaForm", defaultForm());
		if (!form.place) {
			const studios = (await listStudios().catch(() => [])).filter((s) => s.placeId);
			const pick = studios.length
				? (await vscode.window.showQuickPick(studios.map((s) => ({ label: s.name, description: `placeId ${s.placeId}`, s })), { placeHolder: "Which open place should the QA player play?" }))?.s.placeId
				: await vscode.window.showInputBox({ prompt: "No open Studio place found. Place id for the runner to open and play", placeHolder: "90044978600719", validateInput: (v) => /^\d+$/.test(v.trim()) ? undefined : "Digits only." });
			if (!pick) return;
			form.place = pick.trim();
			await this.ctx.globalState.update("qaForm", form);
		}
		await this.run(form);
	}

	// Run: the runner as a child of Parlay's own node (ELECTRON_RUN_AS_NODE, so no node on PATH is needed), with
	// Aqua's URL and ingest key and the TypeSafe key in its environment, its output in the Parlay log and the view.
	async run(form: Form) {
		if (this.child) { void vscode.window.showInformationMessage("A QA run is in progress; stop it first."); return; }
		if (!/^\d+$/.test(form.place)) { warn("pick an open Studio place or type a place id."); return; }
		const key = await this.ctx.secrets.get(TYPESAFE_KEY);
		const policy = form.policy === "jev" && (key || fs.existsSync(TYPESAFE_KEY_FILE)) ? "jev" : "scripted";
		const minutes = Math.min(Math.max(form.minutes || 5, 1), 240);
		const out = path.join(this.dir(), new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
		fs.mkdirSync(out, { recursive: true });
		const args = [path.join(this.ctx.extensionPath, "qa", "play.mjs"), "--place", form.place, "--minutes", String(minutes), "--policy", policy, "--out", out, "--stop-file", path.join(out, "stop")];
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PARLAY_AQUA_URL: aquaUrl(), PARLAY_AQUA_KEY: (await this.ctx.secrets.get(AQUA_INGEST_KEY)) ?? "", PARLAY_TYPESAFE_API_KEY: key ?? "" };
		log.info(`QA: run started: place ${form.place}, ${minutes} min, ${policy} policy, ${out}`);
		const child = spawn(process.execPath, args, { env, cwd: os.homedir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child; this.out = out; this.report = undefined;
		void vscode.commands.executeCommand("setContext", "parlay.qa.running", true);
		this.post({ type: "started", place: this.studios.find((s) => s.placeId === form.place)?.name ?? `place ${form.place}`, minutes, policy });
		let buf = "";
		const onData = (d: Buffer) => {
			buf += d.toString();
			let i;
			while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { log.info(`QA: ${l}`); this.post({ type: "out", text: l }); } }
		};
		child.stdout!.on("data", onData); child.stderr!.on("data", onData);
		const flush = this.tailSteps(out);
		const done = (code: number | null, err?: Error) => {
			if (this.child !== child) return;
			if (this.tail) clearInterval(this.tail);
			flush();
			this.child = undefined;
			void vscode.commands.executeCommand("setContext", "parlay.qa.running", false);
			if (err) log.error(`QA: the runner did not start: ${err.message}`);
			log.info(`QA: runner exit ${code ?? "?"}`);
			this.show(out, code ?? 1, err?.message);
		};
		child.on("error", (e) => done(null, e));
		child.on("exit", (code) => done(code));
	}

	// stepsLog.jsonl, one line per step, read every half second from where the last read stopped
	private tailSteps(out: string) {
		const file = path.join(out, "stepsLog.jsonl");
		let sent = 0;
		const read = () => {
			let text = "";
			try { text = fs.readFileSync(file, "utf8"); } catch { return; }
			const fresh = text.slice(sent), nl = fresh.lastIndexOf("\n");
			if (nl < 0) return;
			sent += nl + 1;
			for (const line of fresh.slice(0, nl).split("\n")) {
				try {
					const s = JSON.parse(line);
					this.post({ type: "step", step: s.step, action: describe(s.action), jev: s.action.jev?.flags?.looksWrong, outcome: s.outcome, newLines: s.newLines ?? [], errorGroups: s.errorGroups, stuck: s.stuck, screenshot: this.shot(out, s.screenshot) });
				} catch { /* a line still being written */ }
			}
		};
		this.tail = setInterval(read, 500);
		return read;
	}

	// Stop: the stop file first (the runner leaves its loop at the next step and stops Play), the process tree if
	// it is still there 30 s later. quiet: Parlay is closing; no message when nothing runs.
	stop(quiet = false) {
		const child = this.child;
		if (!child || !this.out) { if (!quiet) void vscode.window.showInformationMessage("No QA run is in progress."); return; }
		fs.writeFileSync(path.join(this.out, "stop"), "");
		log.info("QA: stop asked; the runner stops Play after this step");
		this.post({ type: "out", text: "Stopping after this step…" });
		const kill = setTimeout(() => {
			if (this.child !== child || !child.pid) return;
			log.warn("QA: the runner is still up after 30 s; killing its process tree");
			if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); else child.kill("SIGKILL");
		}, 30_000);
		child.once("exit", () => clearTimeout(kill));
	}

	// The report of a run folder: the findings with their actions, report.md rendered, the runs list.
	private show(out: string, code?: number, startFailure?: string) {
		this.out = out;
		let report: Report | undefined, md = "";
		try { report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); } catch { /* the runner died before writing one */ }
		try { md = fs.readFileSync(path.join(out, "report.md"), "utf8"); } catch { /* same */ }
		this.report = report;
		if (report) log.info(`QA: ${path.basename(out)}: exit ${report.exitCode}, ${report.errors.length} error groups, ${report.stuck.length} stuck, ${report.suspects?.length ?? 0} suspects; Aqua: ${report.aqua ?? "not attempted"}`);
		const findings = report && {
			errors: report.errors.map((e) => ({ message: e.message, side: e.side, count: e.count, steps: `${e.firstStep}–${e.lastStep}`, trace: e.trace, loc: !!firstLoc(e.message, ...e.trace), screenshot: this.shot(out, e.screenshot), before: e.actionsBefore.map(before) })),
			suspects: (report.suspects ?? []).map((s) => ({ step: s.step, percent: Math.round(s.probability * 100), screenshot: this.shot(out, s.screenshot), console: s.console ?? [], before: s.actionsBefore.map(before) })),
			stuck: report.stuck.map((s) => `step ${s.step}: ${s.state ?? "?"}`),
		};
		this.post({ type: "done", name: path.basename(out), code: code ?? report?.exitCode, failure: startFailure ?? report?.failure, findings,
			report: report && { place: placeName(report), steps: report.steps, aqua: report.aqua, policy: report.policy ?? "scripted" }, md: render(md), runs: this.runs() });
	}

	// Previous runs, newest first: the folder (a timestamp) and the headline counts.
	private runs() {
		let names: string[] = [];
		try { names = fs.readdirSync(this.dir()).sort().reverse().slice(0, 30); } catch { /* none yet */ }
		return names.flatMap((name) => {
			try {
				const r: Report = JSON.parse(fs.readFileSync(path.join(this.dir(), name, "report.json"), "utf8"));
				return [{ name, place: placeName(r), start: r.start, steps: r.steps, errors: r.errors.length, stuck: r.stuck.length, suspects: r.suspects?.length ?? 0, exit: r.exitCode, policy: r.policy ?? "scripted" }];
			} catch { return []; }
		});
	}

	// The script and line an error finding names (aquaText.locate on the message, then its stack), on disk here.
	private async locate(i: number) {
		const e = this.report?.errors[i];
		const loc = e && firstLoc(e.message, ...e.trace);
		if (!e || !loc) { warn("this finding names no script and line."); return undefined; }
		const file = await resolveFile(loc);
		if (!file) { warn(`${pathText(loc)} is not in this folder (Script Sync only mirrors the script containers).`); return undefined; }
		return { e, file, line: loc.line };
	}

	// /parlay-fix on the line, with the error and the actions before it as the brief (the shape aquaIssues.ts sends).
	private async fixWithClaude(i: number) {
		const hit = await this.locate(i);
		if (!hit) return;
		const rel = vscode.workspace.asRelativePath(hit.file, false).replace(/\\/g, "/");
		const trace = hit.e.actionsBefore.map(before).join("; ");
		await this.fix(`/parlay-fix ${rel}:${hit.line}-${hit.line} QA finding: ${clean(hit.e.message).slice(0, 300)}. Steps before: ${clean(trace).slice(0, 400)}`);
	}
}

// ---- the page ------------------------------------------------------------------------------------------------

// report.md as HTML for the view: the constructs the runner writes (# headings, ``` fences, - bullets, **bold**, `code`)
function render(md: string): string {
	const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
	const out: string[] = [];
	let code = false, list = false, para: string[] = [];
	const endPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
	const endList = () => { if (list) { out.push("</ul>"); list = false; } };
	for (const line of md.split(/\r?\n/)) {
		if (line.startsWith("```")) { endPara(); endList(); out.push(code ? "</pre>" : "<pre>"); code = !code; continue; }
		if (code) { out.push(esc(line)); continue; }
		if (line.startsWith("- ")) { endPara(); if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
		endList();
		const h = /^(#{1,3}) (.*)$/.exec(line);
		if (h) { endPara(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
		if (!line.trim()) { endPara(); continue; }
		para.push(line);
	}
	endPara(); endList();
	if (code) out.push("</pre>");
	return out.join("\n");
}

function html(csp: string, script: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src 'unsafe-inline'; script-src ${csp}">
<style>
body{margin:0;padding:10px 12px 24px;font:12px/1.5 var(--vscode-font-family);color:var(--vscode-foreground);background:transparent}
.dim{color:var(--vscode-descriptionForeground)}.err{color:var(--vscode-errorForeground)}.stuck{color:var(--vscode-editorWarning-foreground)}
.mono{font-family:var(--vscode-editor-font-family);font-size:11px}
h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px;color:var(--vscode-descriptionForeground)}
form{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
input,select{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:3px 6px}
#place{flex:1 1 12ch;min-width:10ch}#minutes{width:5ch}
button{padding:4px 14px;border:0;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:hover{background:var(--vscode-button-hoverBackground)}
button.alt{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.alt:hover{background:var(--vscode-button-secondaryHoverBackground)}button.icon{padding:3px 8px}button[disabled]{opacity:.5;cursor:default}
a{color:var(--vscode-textLink-foreground);cursor:pointer}a:hover{text-decoration:underline}
#status{margin:8px 0 4px;min-height:1.5em;overflow-wrap:anywhere}
.step{padding:3px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}.step .n{display:inline-block;min-width:3ch;color:var(--vscode-descriptionForeground)}
pre{margin:4px 0 6px;padding:6px 8px;border-radius:6px;overflow:auto;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.45;white-space:pre-wrap;max-height:12em}
img.shot{display:block;max-width:100%;max-height:160px;border-radius:4px;margin:4px 0;cursor:zoom-in}img.shot.big{max-height:none;cursor:zoom-out}
.finding{padding:8px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}.finding b{overflow-wrap:anywhere}
.actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.run{display:flex;gap:8px;padding:4px 0;cursor:pointer}.run:hover{background:var(--vscode-list-hoverBackground)}.run .c{margin-left:auto;white-space:nowrap}
#md h2{font-size:14px;margin:10px 0 4px}#md h3{text-transform:none;letter-spacing:0;font-size:12px;color:var(--vscode-foreground);margin:10px 0 2px}#md h4{font-size:12px;margin:8px 0 2px}#md ul{margin:0;padding-left:16px}#md p{margin:0 0 6px}
details summary{cursor:pointer;margin:12px 0 4px;font-weight:600}
</style></head><body>
<form id="f">
<input id="place" list="studios" placeholder="place id" title="An open Studio place, or a place id for the runner to open" required pattern="\\d+"><datalist id="studios"></datalist>
<button type="button" id="refresh" class="alt icon" title="Look for open Studio places again">↻</button>
<label title="How long to play"><input id="minutes" type="number" min="1" max="240" step="1" value="5"> min</label>
<select id="policy" title="Who decides what the player does next"><option value="jev">Jev (TypeSafe)</option><option value="scripted">Scripted</option></select>
<button type="submit" id="run">Run</button><button type="button" id="stop" class="alt" hidden>Stop</button>
</form>
<div id="nokey" class="dim" hidden>Scripted only: <a id="setkey">set a TypeSafe key</a> and Jev picks the actions and flags what looks wrong.</div>
<div id="status" class="dim">Pick an open Studio place and Run. The runner takes Studio's MCP seat while it plays.</div>
<div id="steps"></div>
<div id="result" hidden><h3 id="headline"></h3><div id="findings"></div><details><summary>Full report</summary><div id="md"></div><a id="open">Open report.md</a></details></div>
<h3>Previous runs</h3><div id="runs" class="dim">None yet.</div>
<script src="${script}"></script>
</body></html>`;
}

// ---- registration --------------------------------------------------------------------------------------------

export function registerQa(ctx: vscode.ExtensionContext, fix: (line: string) => Promise<void>) {
	const view = new QaView(ctx, fix);
	// a key in SecretStorage; an empty answer removes it (the Accounts page has Remove too)
	const setKey = async (name: string, prompt: string) => {
		const v = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
		if (v === undefined) return;
		if (v.trim()) await ctx.secrets.store(name, v.trim()); else await ctx.secrets.delete(name);
	};
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider("parlay.qa", view, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand("parlay.qa.run", () => view.runCommand()),
		vscode.commands.registerCommand("parlay.qa.stop", () => view.stop()),
		vscode.commands.registerCommand("parlay.qa.open", () => vscode.commands.executeCommand("parlay.qa.focus")),
		vscode.commands.registerCommand("parlay.typesafe.setKey", () => setKey(TYPESAFE_KEY, "TypeSafe API key (typesafe.ai): Jev picks the QA player's next action and flags what looks wrong. Empty removes it.")),
		vscode.commands.registerCommand("parlay.aqua.setIngestKey", () => setKey(AQUA_INGEST_KEY, "Aqua ingest key for this game (Aqua, Setup page): the QA runner posts its findings with it. Empty removes it.")),
		ctx.secrets.onDidChange((e) => { if (e.key === TYPESAFE_KEY) void view.init(); }),
		{ dispose: () => view.stop(true) },   // Parlay closing mid-run: the runner stops Play rather than playing on headless
	);
	void vscode.commands.executeCommand("setContext", "parlay.qa.running", false);
}
