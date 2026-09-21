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
interface Note { step: number; kind: string; text: string; probability: number; screenshot?: string; console: string[]; actionsBefore: Hist[] }
interface Report { place: string; studio?: { name: string }; policy?: string; agent?: string; doneBy?: string; start: string; end?: string; steps: number; errors: Finding[]; stuck: { step: number; state?: string }[]; suspects?: Suspect[]; notes?: Note[]; exitCode: number; failure?: string; aqua?: string }
interface Form { place: string; agent: string; policy: "" | "scripted" | "jev" }
// the personalities of qa/agents.mjs, as the picker shows them (the runner validates the id)
const AGENTS: Record<string, [string, string]> = {
	explorer: ["Explorer", "Wanders, presses every button, uses every prompt. Finds crashes and dead ends."],
	ui: ["UI tester", "Only the interface: opens every menu, presses every button, checks each one did something."],
	breaker: ["Breaker", "Tries to cheat: spams prompts, runs at edges, buys with nothing. Watches for stats that change without cause."],
	newbie: ["Newbie", "A first-time player with no help. Reports where they would not know what to do next."],
};

const describe = (a: Action) => a.kind === "click" ? `click ${a.text ?? ""}` : a.kind === "interact" ? `${a.class} ${a.path?.split(".").pop()}` : `walk ${a.key}`;
const before = (h: Hist) => `${h.step}: ${describe(h.action)}${h.result ? ` → ${h.result}` : ""}`;
const placeName = (r: Report) => r.studio?.name?.replace(/\s*\(placeId:.*\)$/, "") || `place ${r.place}`;
const clean = (s: string) => s.replace(/["\r\n]/g, "'");
const warn = (m: string) => { log.warn(`QA: ${m}`); void vscode.window.showWarningMessage(`Parlay QA: ${m}`); };
const defaultForm = (): Form => ({ place: "", agent: "explorer", policy: "" });

class QaView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private child?: ChildProcess;
	private out?: string;          // the folder of the running, or last shown, run
	private report?: Report;       // its report once written: the findings' buttons work from it
	private studios: { name: string; placeId: string }[] = [];
	private tail?: NodeJS.Timeout;
	private live?: { place: string; agent: string; policy: string; at: number };   // the run in progress, for the view's clock

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
		view.webview.html = html(view.webview.cspSource, (f) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", f)).toString());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		view.webview.onDidReceiveMessage((m: any) => void this.onMessage(m));
		view.onDidDispose(() => { this.view = undefined; });
		void this.init();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async onMessage(m: any) {
		switch (m?.type) {
			case "run": { const form: Form = { place: String(m.place ?? "").trim(), agent: AGENTS[m.agent] ? m.agent : "explorer", policy: m.policy === "jev" ? "jev" : "scripted" }; await this.ctx.globalState.update("qaForm", form); await this.run(form); break; }
			case "stop": this.stop(); break;
			case "refresh": await this.init(true); break;
			case "setKey": await vscode.commands.executeCommand("parlay.typesafe.setKey"); break;
			case "show": this.show(path.join(this.dir(), path.basename(String(m.name))), false); break;
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
		this.post({ type: "init", studios: this.studios, form: { ...form, policy: hasKey ? form.policy || "jev" : "scripted" }, hasKey, running: !!this.child, live: this.live, runs: this.runs() });
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
		const agent = AGENTS[form.agent] ? form.agent : "explorer";
		const out = path.join(this.dir(), new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
		fs.mkdirSync(out, { recursive: true });
		// no --minutes: with Jev the agent says when it is done (the runner caps at 20 min), scripted plays its 5
		const args = [path.join(this.ctx.extensionPath, "qa", "play.mjs"), "--place", form.place, "--policy", policy, "--agent", agent, "--out", out, "--stop-file", path.join(out, "stop")];
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PARLAY_AQUA_URL: aquaUrl(), PARLAY_AQUA_KEY: (await this.ctx.secrets.get(AQUA_INGEST_KEY)) ?? "", PARLAY_TYPESAFE_API_KEY: key ?? "" };
		log.info(`QA: run started: place ${form.place}, ${policy} policy, ${agent} agent, ${out}`);
		const child = spawn(process.execPath, args, { env, cwd: os.homedir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child; this.out = out; this.report = undefined;
		void vscode.commands.executeCommand("setContext", "parlay.qa.running", true);
		this.live = { place: this.studios.find((s) => s.placeId === form.place)?.name ?? `place ${form.place}`, agent, policy, at: Date.now() };
		this.post({ type: "started", ...this.live });
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
			this.child = undefined; this.live = undefined;
			void vscode.commands.executeCommand("setContext", "parlay.qa.running", false);
			if (err) log.error(`QA: the runner did not start: ${err.message}`);
			log.info(`QA: runner exit ${code ?? "?"}`);
			this.show(out, true, code ?? 1, err?.message);
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
					this.post({ type: "step", step: s.step, action: describe(s.action), jev: s.action.jev?.flags?.looksWrong, done: s.action.jev ? s.done : undefined, notes: s.notes ?? [], outcome: s.outcome, newLines: s.newLines ?? [], errorGroups: s.errorGroups, stuck: s.stuck, suspect: !!s.suspect, screenshot: this.shot(out, s.screenshot) });
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
	// final: the run that was in progress just ended (the view closes its live card); false for a previous run.
	private show(out: string, final: boolean, code?: number, startFailure?: string) {
		this.out = out;
		let report: Report | undefined, md = "";
		try { report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")); } catch { /* the runner died before writing one */ }
		try { md = fs.readFileSync(path.join(out, "report.md"), "utf8"); } catch { /* same */ }
		this.report = report;
		if (report) log.info(`QA: ${path.basename(out)}: exit ${report.exitCode}, ${report.errors.length} error groups, ${report.stuck.length} stuck, ${report.suspects?.length ?? 0} suspects; Aqua: ${report.aqua ?? "not attempted"}`);
		const findings = report && {
			errors: report.errors.map((e) => ({ message: e.message, side: e.side, count: e.count, steps: `${e.firstStep}–${e.lastStep}`, trace: e.trace, loc: !!firstLoc(e.message, ...e.trace), screenshot: this.shot(out, e.screenshot), before: e.actionsBefore.map(before) })),
			suspects: (report.suspects ?? []).map((s) => ({ step: s.step, percent: Math.round(s.probability * 100), screenshot: this.shot(out, s.screenshot), console: s.console ?? [], before: s.actionsBefore.map(before) })),
			notes: (report.notes ?? []).map((n) => ({ step: n.step, kind: n.kind, text: n.text, percent: Math.round(n.probability * 100), screenshot: this.shot(out, n.screenshot), console: n.console ?? [], before: n.actionsBefore.map(before) })),
			stuck: report.stuck.map((s) => `step ${s.step}: ${s.state ?? "?"}`),
		};
		this.post({ type: "done", final, name: path.basename(out), code: code ?? report?.exitCode, failure: startFailure ?? report?.failure, findings,
			report: report && { place: placeName(report), steps: report.steps, aqua: report.aqua, policy: report.policy ?? "scripted", agent: report.agent ?? "explorer", doneBy: report.doneBy, duration: report.end ? Math.max(0, (Date.parse(report.end) - Date.parse(report.start)) / 1000) : 0 },
			md: render(md), runs: this.runs() });
	}

	// Previous runs, newest first: the folder (a timestamp) and the headline counts.
	private runs() {
		let names: string[] = [];
		try { names = fs.readdirSync(this.dir()).sort().reverse().slice(0, 30); } catch { /* none yet */ }
		return names.flatMap((name) => {
			try {
				const r: Report = JSON.parse(fs.readFileSync(path.join(this.dir(), name, "report.json"), "utf8"));
				return [{ name, place: placeName(r), start: r.start, steps: r.steps, errors: r.errors.length, stuck: r.stuck.length, suspects: r.suspects?.length ?? 0, notes: r.notes?.length ?? 0, exit: r.exitCode, policy: r.policy ?? "scripted", agent: r.agent ?? "explorer" }];
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

// The page: header, the setup card (place, duration, player, Play test), the live card while a run is on (clock,
// progress, counts, Stop), the result (verdict, findings, the report), the steps feed, previous runs. Styles in
// media/qa.css, behaviour in media/qa.js.
function html(csp: string, media: (file: string) => string): string {
	const shield = `<svg viewBox="0 0 24 24"><path d="M12 2.8l8 3.2v6c0 4.6-3.4 8.2-8 9.6-4.6-1.4-8-5-8-9.6V6L12 2.8z"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/></svg>`;
	return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src ${csp}; script-src ${csp}">
<link rel="stylesheet" href="${media("qa.css")}"></head><body>
<header><span class="mark">${shield}</span><h1>Quality Assurance<small>Jev plays your game and reports what breaks</small></h1>
<button id="refresh" class="icon-button" title="Look for open Studio places again"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg></button></header>
<main>
<section id="setup"><div class="card">
<div class="field"><label for="place">Place</label><select id="place"></select><input id="placeId" type="text" inputmode="numeric" placeholder="Place id, e.g. 90044978600719" hidden>
<div id="empty" class="note" hidden>No open Studio place found. Open one in Studio and refresh, or enter a place id and the runner opens it.</div></div>
<div class="field"><label>Player</label><div class="seg" id="policy"><button data-v="jev">Jev<small>by TypeSafe</small></button><button data-v="scripted">Scripted<small>walk, click, interact</small></button></div></div>
<div class="field"><label>What to test</label><div class="tiles" id="agent">${Object.entries(AGENTS).map(([id, [name, blurb]]) => `<button class="tile" data-v="${id}"><b>${name}</b><small>${blurb}</small></button>`).join("")}</div></div>
<button id="run" class="primary"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>Play test</button>
<p class="note" id="keynote"></p>
<p class="note">Plays until the agent has seen enough (20 minute cap). Takes Studio's MCP seat while it plays and stops Play on its way out.</p>
</div></section>
<section id="live" hidden><div class="card live">
<div class="title"><b id="liveplace"></b><span id="clock"></span></div>
<div class="bar" title="How sure the agent is that it has seen enough"><i id="bar"></i></div><div class="barlabel" id="donelabel"></div>
<div class="counts"><span class="chip">steps <b id="c-steps">0</b></span><span class="chip red">errors <b id="c-err">0</b></span><span class="chip blue">notes <b id="c-notes">0</b></span><span class="chip purple">suspects <b id="c-sus">0</b></span><span class="chip amber">stuck <b id="c-stuck">0</b></span></div>
<div class="status" id="status"></div>
<button id="stop" class="primary stop"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop after this step</button>
</div></section>
<section id="result" hidden><h2>Result</h2><div class="card"><div class="verdict" id="verdict"></div><div class="counts" id="rcounts"></div></div><div id="findings"></div>
<details class="report"><summary>Full report</summary><div class="md" id="md"></div><div class="actions"><button class="btn alt" id="open">Open report.md</button></div></details></section>
<section id="feed" hidden><h2>Steps <span id="feedcount"></span></h2><div id="steps"></div></section>
<section><h2>Previous runs</h2><div id="runs"></div></section>
</main>
<script src="${media("qa.js")}"></script>
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
