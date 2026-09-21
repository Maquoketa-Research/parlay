// Parlay QA triage: Claude reads a finished session and turns its findings into a bug list (a plain title, a
// verdict with one sentence of why, the script and line when it can find them). Read-only: the headless CLI gets
// Read, Grep and Glob inside the workspace and nothing else, so fixing stays one click away (Fix with Claude).
// Output: <run>/triage.json, also returned. Ignored findings (the Ignore button) are keyed so the same bug does
// not come back next run: an error by its message with numbers stripped, a note by its kind and target.
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { exe } from "./agents";
import { log } from "./log";

export interface Triaged { id: string; title: string; verdict: "bug" | "look" | "fine"; why: string; file?: string; line?: number; key: string }
export interface TriageFile { at: string; ws: string; findings: Triaged[]; error?: string }   // ws: the folder the files are relative to

/* eslint-disable @typescript-eslint/no-explicit-any */
const describe = (a: any) => a?.kind === "click" ? `click "${a.text ?? ""}" (${a.path})` : a?.kind === "interact" ? `${a.class} ${a.path}` : `walk ${a?.key ?? "?"}`;
const trail = (h: any[]) => (h ?? []).map((x) => `${x.step}: ${describe(x.action)}${x.result ? ` → ${x.result}` : ""}`).join("; ");

// stable across runs for errors and notes; suspects and stuck spots belong to their run
export function keyOf(report: any, id: string): string {
	const [kind, i] = id.split("-"), n = Number(i);
	if (kind === "error") return `error:${String(report.errors?.[n]?.message ?? "").replace(/\d+/g, "#")}`;
	if (kind === "note") { const x = report.notes?.[n]; return `note:${x?.kind}:${x?.actionsBefore?.at(-1)?.action?.path ?? x?.text}`; }
	return `${id}@${report.start}`;
}

function prompt(report: any): string {
	const lines: string[] = [];
	report.errors?.forEach((e: any, i: number) => lines.push(`- id error-${i}: console error ×${e.count} on the ${e.side}: ${e.message}${e.trace?.length ? `\n  stack: ${e.trace.slice(0, 6).join(" | ")}` : ""}\n  before: ${trail(e.actionsBefore)}`));
	report.notes?.forEach((n: any, i: number) => lines.push(`- id note-${i}: ${n.kind} (Jev ${Math.round(n.probability * 100)}%): ${n.text}\n  the action it concerns: ${describe(n.actionsBefore?.at(-1)?.action)}\n  before: ${trail(n.actionsBefore)}${n.console?.length ? `\n  console then: ${n.console.join(" | ")}` : ""}`));
	report.suspects?.forEach((s: any, i: number) => lines.push(`- id suspect-${i}: Jev put "something is broken for a player" at ${Math.round(s.probability * 100)}% at step ${s.step}, no console error\n  before: ${trail(s.actionsBefore)}${s.console?.length ? `\n  console then: ${s.console.join(" | ")}` : ""}`));
	report.stuck?.forEach((s: any, i: number) => lines.push(`- id stuck-${i}: the player was stuck from step ${s.step} (${s.state ?? "?"} at ${JSON.stringify(s.position)})\n  actions: ${trail(s.actions)}`));
	return `A QA agent (${report.agent ?? "explorer"}) just played this Roblox place${report.brief ? ` with the task "${report.brief}"` : ""} for ${report.steps} steps. This folder holds the game's scripts (a Script Sync mirror: ServerScriptService, ReplicatedStorage, StarterGui, StarterPlayer and so on). Triage its findings.

For each finding decide: "bug" (a defect a player would hit), "look" (plausible, could not be confirmed from the code), or "fine" (expected behaviour, or noise from the test itself). Use Grep and Read to find the script that owns each button, prompt or error: search the button's name (for example CloseButton, or the frame it sits in) under StarterGui and StarterPlayer, and the script names in error messages. A "dead-button" note means the buttons on screen, the stats and the console did not change after the click: a button with no Activated or MouseButton1Click connection anywhere is a bug; one whose handler closes an already closed frame is fine.

Reply with ONLY a JSON object, no prose before or after:
{"findings":[{"id":"error-0","title":"short plain-English title, no ids","verdict":"bug|look|fine","why":"one sentence","file":"path relative to this folder, when found","line":1}]}

Findings:
${lines.join("\n")}`;
}

// claude -p with the prompt on stdin and the JSON envelope on stdout; three minutes at most
export function triage(out: string, report: any, ws: string): Promise<TriageFile> {
	return new Promise((resolve) => {
		const at = new Date().toISOString();
		const finish = (r: Omit<TriageFile, "ws">) => { const full = { ...r, ws }; try { fs.writeFileSync(path.join(out, "triage.json"), JSON.stringify(full, null, "\t")); } catch { /* the run folder is gone */ } resolve(full); };
		let child: ChildProcess;
		try { child = spawn(exe("claude"), ["-p", "--output-format", "json", "--allowedTools", "Read", "Grep", "Glob"], { cwd: ws, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
		catch (e) { return finish({ at, findings: [], error: `could not start claude: ${(e as Error).message}` }); }
		let stdout = "", stderr = "";
		child.stdout!.on("data", (d) => { stdout += d; });
		child.stderr!.on("data", (d) => { stderr += d; });
		const timer = setTimeout(() => { child.kill(); finish({ at, findings: [], error: "Claude took more than three minutes" }); }, 180_000);
		child.on("error", (e) => { clearTimeout(timer); finish({ at, findings: [], error: e.message }); });
		child.on("exit", (code) => {
			clearTimeout(timer);
			try {
				const env = JSON.parse(stdout);
				const text = String(env.result ?? "");
				const m = /\{[\s\S]*\}/.exec(text);
				const parsed = m ? JSON.parse(m[0]) : null;
				if (!parsed?.findings) throw new Error(env.is_error ? text.slice(0, 300) : "no JSON in the answer");
				const findings: Triaged[] = parsed.findings.filter((f: any) => f && typeof f.id === "string").map((f: any) => ({
					id: f.id, title: String(f.title ?? f.id).slice(0, 120), verdict: ["bug", "look", "fine"].includes(f.verdict) ? f.verdict : "look", why: String(f.why ?? "").slice(0, 400),
					file: typeof f.file === "string" && f.file ? f.file.replace(/\\/g, "/") : undefined, line: Number(f.line) > 0 ? Math.floor(Number(f.line)) : undefined, key: keyOf(report, f.id),
				}));
				log.info(`QA triage: ${findings.length} findings, ${findings.filter((f) => f.verdict === "bug").length} bugs, ${env.duration_ms ?? "?"} ms`);
				finish({ at, findings });
			} catch (e) {
				log.warn(`QA triage failed (exit ${code}): ${(e as Error).message}; stderr: ${stderr.slice(0, 200)}`);
				finish({ at, findings: [], error: (e as Error).message });
			}
		});
		child.stdin!.end(prompt(report));
	});
}
