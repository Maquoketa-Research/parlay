// The Meshy tab, as a workflow: describe a prop; the game's own screenshots set the style; a few concept
// drafts come back from an image model; approve one; Meshy turns it into a textured 3D model; a four-view
// turntable lets you approve or reject; approval uploads it to Roblox through Open Cloud and a Claude skill
// inserts it into the open Studio. Keys live in SecretStorage, never in settings files.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

const MESHY = "https://api.meshy.ai";
const ROBLOX = "https://apis.roblox.com/assets/v1";
const OPENAI = "https://api.openai.com/v1";
const KEYS = { meshy: "drydock.meshyApiKey", roblox: "drydock.robloxApiKey", openai: "drydock.openaiApiKey" } as const;
type KeyName = keyof typeof KEYS;

export interface Job {
	id: string;
	prompt: string;
	slug: string;
	dir: string;                 // <workspace>/<assetsDir>/<slug>-<id>
	createdAt: number;
	status: "drafting" | "drafts" | "modeling" | "review" | "uploading" | "done" | "failed";
	refs: string[];              // reference screenshots used for the drafts
	drafts: string[];            // draft PNG paths
	chosen?: number;             // index into drafts
	meshyId?: string;
	progress?: number;
	thumbnail?: string;
	views?: Record<string, string>;   // front/right/back/left from Meshy
	modelUrls?: Record<string, string>;
	file?: string;               // local .glb
	robloxOp?: string;
	robloxAssetId?: string;
	error?: string;
	note?: string;
}

export class MeshyView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private jobs: Job[];
	private timer?: NodeJS.Timeout;

	constructor(private ctx: vscode.ExtensionContext, private insert: (assetId: string, name: string) => Promise<void>) {
		this.jobs = ctx.globalState.get<Job[]>("meshyJobs", []);
	}

	// ---- keys and settings -------------------------------------------------------------------------

	async setKey(which: KeyName) {
		const prompts = { meshy: "Meshy API key (meshy.ai, Settings, API Keys)", roblox: "Roblox Open Cloud API key with Assets read and write", openai: "OpenAI API key (for the concept drafts)" };
		const v = await vscode.window.showInputBox({ prompt: prompts[which], password: true, ignoreFocusOut: true });
		if (v === undefined) return;
		await this.ctx.secrets.store(KEYS[which], v.trim());
		void this.push();
	}

	private async key(which: KeyName): Promise<string | undefined> {
		return (await this.ctx.secrets.get(KEYS[which])) || (which === "openai" ? process.env.OPENAI_API_KEY : undefined);
	}

	private cfg<T>(k: string, d: T): T { return vscode.workspace.getConfiguration("drydock").get<T>(k, d); }
	private ws(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(process.env.USERPROFILE ?? ".", "Documents"); }
	private assetsRoot(): string { const d = path.join(this.ws(), this.cfg("assetsDir", "assets/meshy")); fs.mkdirSync(d, { recursive: true }); return d; }

	// ---- the view ----------------------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.assetsRoot()), vscode.Uri.file(this.ws())] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
		view.onDidChangeVisibility(() => { if (view.visible) void this.push(); });
		view.onDidDispose(() => { this.view = undefined; });
		void this.push();
		this.schedule();
	}

	private async onMessage(m: { type: string; id?: string; index?: number; prompt?: string; which?: string }) {
		const job = m.id ? this.jobs.find((j) => j.id === m.id) : undefined;
		try {
			switch (m.type) {
				case "draft": await this.draft(String(m.prompt ?? "")); break;
				case "approveDraft": if (job) await this.approveDraft(job, Number(m.index)); break;
				case "denyDraft": if (job) { job.drafts.splice(Number(m.index), 1); if (!job.drafts.length) { job.status = "failed"; job.error = "every draft was rejected; try a different description"; } } break;
				case "approveModel": if (job) await this.approveModel(job); break;
				case "denyModel": if (job) { job.status = "drafts"; job.meshyId = undefined; job.views = undefined; job.modelUrls = undefined; job.thumbnail = undefined; job.note = "model rejected; pick another draft"; } break;
				case "insert": if (job?.robloxAssetId) await this.insert(job.robloxAssetId, job.prompt); break;
				case "open": if (job) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(job.file ?? job.dir)); break;
				case "remove": this.jobs = this.jobs.filter((j) => j !== job); break;
				case "setKey": await this.setKey((m.which as KeyName) ?? "meshy"); break;
				case "settings": await vscode.commands.executeCommand("workbench.action.openSettings", "drydock."); break;
				case "refresh": await this.poll(); break;
			}
		} catch (e) {
			if (job) { job.error = (e as Error).message; if (job.status === "drafting") job.status = "failed"; }
			else void vscode.window.showErrorMessage(`Meshy: ${(e as Error).message}`);
		}
		await this.save(); await this.push();
	}

	private async save() { await this.ctx.globalState.update("meshyJobs", this.jobs); }

	private async push() {
		if (!this.view) return;
		const w = this.view.webview;
		const uri = (p: string) => (p.startsWith("http") ? p : w.asWebviewUri(vscode.Uri.file(p)).toString());
		void w.postMessage({
			type: "state",
			jobs: this.jobs.map((j) => ({ ...j, drafts: j.drafts.map(uri), refs: j.refs.map(uri), thumbnail: j.thumbnail && uri(j.thumbnail) })),
			keys: { meshy: !!(await this.key("meshy")), roblox: !!(await this.key("roblox")), openai: !!(await this.key("openai")) },
			creator: `${this.cfg("robloxCreatorType", "user")} ${this.cfg("robloxCreatorId", "") || "(not set)"}`,
			refDir: this.cfg("referenceDir", "assets/reference"),
		});
	}

	// ---- step 1: drafts ---------------------------------------------------------------------------

	private async draft(prompt: string) {
		prompt = prompt.trim();
		if (!prompt) throw new Error("describe the prop first");
		const id = Date.now().toString(36);
		const slug = slugOf(prompt);
		const dir = path.join(this.assetsRoot(), `${slug}-${id}`);
		fs.mkdirSync(dir, { recursive: true });
		const job: Job = { id, prompt, slug, dir, createdAt: Date.now(), status: "drafting", refs: [], drafts: [] };
		this.jobs.unshift(job);
		await this.save(); await this.push();
		try {
			job.refs = await this.gatherRefs(dir);
			job.note = job.refs.length ? `style from ${job.refs.length} screenshot${job.refs.length === 1 ? "" : "s"}` : "no screenshots found; drafts follow the description alone";
			await this.push();
			job.drafts = await this.openaiDrafts(job);
			job.status = "drafts";
		} catch (e) {
			job.status = "failed"; job.error = (e as Error).message;
		}
	}

	// Screenshots of the game: whatever is in the reference folder, plus one live Studio capture when the
	// Studio MCP is not held by another client (Claude Code holds it while it runs).
	private async gatherRefs(dir: string): Promise<string[]> {
		const refs: string[] = [];
		const refDir = path.join(this.ws(), this.cfg("referenceDir", "assets/reference"));
		if (fs.existsSync(refDir)) {
			for (const f of fs.readdirSync(refDir)) if (/\.(png|jpe?g)$/i.test(f)) refs.push(path.join(refDir, f));
		}
		const shot = await studioCapture(path.join(dir, "studio.png")).catch(() => undefined);
		if (shot) refs.unshift(shot);
		return refs.slice(0, 6);
	}

	private async openaiDrafts(job: Job): Promise<string[]> {
		const key = await this.key("openai");
		if (!key) throw new Error("no OpenAI API key (Drydock: Set OpenAI API key), and OPENAI_API_KEY is not set");
		const model = this.cfg("imageModel", "gpt-image-1");
		const n = 3;
		const base = `Concept art for a Roblox game prop: ${job.prompt}. One object only, centred, three-quarter view, plain neutral background, no text, no people, no hands.`;
		let res: Response;
		if (job.refs.length) {
			const form = new FormData();
			form.append("model", model); form.append("n", String(n)); form.append("size", "1024x1024"); form.append("quality", "medium");
			form.append("prompt", `${base} Match the look of the reference screenshots exactly: same colour palette, material language, level of detail and lighting mood, so it belongs in that world.`);
			for (const r of job.refs) form.append("image[]", new Blob([fs.readFileSync(r)], { type: r.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" }), path.basename(r));
			res = await fetch(`${OPENAI}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
		} else {
			res = await fetch(`${OPENAI}/images/generations`, {
				method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model, prompt: `${base} Stylised, game-ready, readable silhouette.`, n, size: "1024x1024", quality: "medium" }),
			});
		}
		const text = await res.text();
		if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
		const data = JSON.parse(text).data as { b64_json?: string; url?: string }[];
		const out: string[] = [];
		for (const [i, d] of data.entries()) {
			const file = path.join(job.dir, `draft-${i + 1}.png`);
			if (d.b64_json) fs.writeFileSync(file, Buffer.from(d.b64_json, "base64"));
			else if (d.url) await save(d.url, file);
			else continue;
			out.push(file);
		}
		if (!out.length) throw new Error("the image model returned no images");
		return out;
	}

	// ---- step 2: the model -------------------------------------------------------------------------

	private async meshy(method: string, p: string, body?: unknown): Promise<any> {
		const key = await this.key("meshy");
		if (!key) throw new Error("no Meshy API key (Drydock: Set Meshy API key)");
		const r = await fetch(MESHY + p, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		const text = await r.text();
		if (!r.ok) throw new Error(`Meshy ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	private async approveDraft(job: Job, index: number) {
		const file = job.drafts[index]; if (!file) return;
		job.chosen = index; job.error = undefined; job.note = undefined;
		const buf = fs.readFileSync(file);
		const res = await this.meshy("POST", "/openapi/v1/image-to-3d", {
			image_url: `data:image/png;base64,${buf.toString("base64")}`,
			ai_model: this.cfg("meshyModel", "latest"), should_texture: true, enable_pbr: this.cfg("meshyPbr", false),
			should_remesh: true, target_polycount: this.cfg("meshyPolycount", 10000), target_formats: ["glb", "fbx"],
			texture_prompt: job.prompt, multi_view_thumbnails: true, image_enhancement: true,
		});
		job.meshyId = res.result; job.status = "modeling"; job.progress = 0;
		this.schedule();
	}

	private schedule() { if (!this.timer) this.timer = setInterval(() => void this.poll(), 4000); }

	private async poll() {
		const live = this.jobs.filter((j) => j.status === "modeling" || j.status === "uploading");
		if (!live.length) { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } return; }
		for (const j of live) {
			try {
				if (j.status === "modeling" && j.meshyId) {
					const r = await this.meshy("GET", `/openapi/v1/image-to-3d/${j.meshyId}`);
					j.progress = r.progress ?? j.progress; j.thumbnail = r.thumbnail_url ?? j.thumbnail;
					if (r.thumbnail_urls) j.views = r.thumbnail_urls;
					if (r.status === "SUCCEEDED") { j.modelUrls = r.model_urls; j.status = "review"; }
					else if (r.status === "FAILED" || r.status === "CANCELED") { j.status = "failed"; j.error = r.task_error?.message ?? `Meshy task ${r.status.toLowerCase()}`; }
				} else if (j.status === "uploading" && j.robloxOp) {
					const r = await this.roblox("GET", "/" + j.robloxOp);
					if (r.done) {
						if (r.response?.assetId) { j.robloxAssetId = String(r.response.assetId); j.status = "done"; await this.insert(j.robloxAssetId, j.prompt).catch(() => undefined); }
						else { j.status = "failed"; j.error = r.error?.message ?? JSON.stringify(r).slice(0, 200); }
					}
				}
			} catch (e) { j.error = (e as Error).message; }
		}
		await this.save(); await this.push();
	}

	// ---- step 3: approve the model -----------------------------------------------------------------

	private async roblox(method: string, p: string, body?: FormData): Promise<any> {
		const key = await this.key("roblox");
		if (!key) throw new Error("no Roblox Open Cloud key (Drydock: Set Roblox Open Cloud API key)");
		const r = await fetch(ROBLOX + p, { method, headers: { "x-api-key": key }, body });
		const text = await r.text();
		if (!r.ok) throw new Error(`Roblox ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	private async approveModel(job: Job) {
		if (!job.modelUrls?.glb) throw new Error("no model yet");
		job.file = path.join(job.dir, "model.glb");
		await save(job.modelUrls.glb, job.file);
		if (job.modelUrls.fbx) await save(job.modelUrls.fbx, path.join(job.dir, "model.fbx"));
		const creatorId = this.cfg("robloxCreatorId", "");
		if (!creatorId) { job.note = `model saved to ${job.dir}; set drydock.robloxCreatorId to upload it to Roblox`; return; }
		const creator = this.cfg<string>("robloxCreatorType", "user") === "group" ? { groupId: creatorId } : { userId: creatorId };
		const form = new FormData();
		form.append("request", JSON.stringify({ assetType: "Model", displayName: job.prompt.slice(0, 50), description: `Meshy ${job.meshyId}`, creationContext: { creator } }));
		form.append("fileContent", new Blob([fs.readFileSync(job.file)], { type: "model/gltf-binary" }), "model.glb");
		const res = await this.roblox("POST", "/assets", form);
		job.robloxOp = res.path; job.status = "uploading"; job.error = undefined;
		this.schedule();
	}

	// ---- html --------------------------------------------------------------------------------------

	private html(webview: vscode.Webview): string {
		const nonce = Math.random().toString(36).slice(2);
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;padding:10px 12px;font:13px/1.45 var(--vscode-font-family);color:var(--vscode-foreground);background:transparent}
textarea{width:100%;box-sizing:border-box;min-height:52px;resize:vertical;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:8px;padding:6px 8px;font:inherit}
.row{display:flex;gap:8px;align-items:center;margin-top:8px}
button{border:0;border-radius:999px;padding:5px 12px;font:inherit;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:disabled{opacity:.5;cursor:default}
.keys{margin-top:8px;font-size:12px;color:var(--vscode-descriptionForeground)}
.keys a{color:var(--vscode-textLink-foreground);cursor:pointer;margin-left:4px}
.job{padding:12px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
.job .t{font-weight:600}
.job .s{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:2px}
.job .err{font-size:12px;color:var(--vscode-errorForeground);margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:8px}
.card{position:relative;border-radius:10px;overflow:hidden;background:var(--vscode-editorWidget-background)}
.card img{display:block;width:100%;aspect-ratio:1;object-fit:cover}
.card .acts{display:flex;gap:4px;padding:6px;justify-content:center}
.card .acts button{padding:3px 9px;font-size:12px}
.views{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.views img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:var(--vscode-editorWidget-background)}
.views .cap{font-size:11px;color:var(--vscode-descriptionForeground);text-align:center;margin-top:2px}
.bar{height:3px;border-radius:2px;background:var(--vscode-progressBar-background);opacity:.35;margin:8px 0 4px}
.bar>i{display:block;height:100%;border-radius:2px;background:var(--vscode-progressBar-background)}
.acts2{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.acts2 button{padding:4px 11px;font-size:12px}
.empty{color:var(--vscode-descriptionForeground);padding:18px 0;text-align:center}
.refs{display:flex;gap:4px;margin-top:6px}
.refs img{width:36px;height:36px;object-fit:cover;border-radius:6px;opacity:.85}
</style></head><body>
<textarea id="prompt" placeholder="What does the game need? An axe, a rusted gas pump, a lantern for the dock..."></textarea>
<div class="row"><span class="keys" id="keys" style="flex:1;margin:0"></span><button id="go" class="primary">Draft</button></div>
<div id="list"></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi(); const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("go").onclick = () => { vs.postMessage({ type: "draft", prompt: $("prompt").value }); $("prompt").value = ""; };
function render(st) {
  const k = st.keys;
  $("keys").innerHTML = ["openai", "meshy", "roblox"].map((n) => n + ": " + (k[n] ? "set" : '<a data-k="' + n + '">set key</a>')).join(" · ") + ' · creator ' + esc(st.creator) + ' <a data-s="1">settings</a>';
  document.querySelectorAll("#keys a[data-k]").forEach((a) => a.onclick = () => vs.postMessage({ type: "setKey", which: a.dataset.k }));
  document.querySelectorAll("#keys a[data-s]").forEach((a) => a.onclick = () => vs.postMessage({ type: "settings" }));
  if (!st.jobs.length) { $("list").innerHTML = '<div class="empty">Describe a prop and press Draft. Screenshots in <b>' + esc(st.refDir) + '</b> (and a live Studio capture when free) set the style.</div>'; return; }
  $("list").innerHTML = st.jobs.map((j) => {
    let body = "";
    if (j.status === "drafting") body = '<div class="bar"><i style="width:35%"></i></div><div class="s">drafting concept images…</div>';
    if (j.status === "drafts") body = '<div class="grid">' + j.drafts.map((d, i) => '<div class="card"><img src="' + esc(d) + '"><div class="acts"><button class="primary" data-a="approveDraft" data-i="' + i + '">Use</button><button data-a="denyDraft" data-i="' + i + '">No</button></div></div>').join("") + "</div>";
    if (j.status === "modeling") body = '<div class="bar"><i style="width:' + (j.progress || 2) + '%"></i></div><div class="s">Meshy is modelling · ' + (j.progress || 0) + '%</div>' + (j.thumbnail ? '<div class="grid"><div class="card"><img src="' + esc(j.thumbnail) + '"></div></div>' : "");
    if (j.status === "review") {
      const v = j.views || {}; const order = ["front", "right", "back", "left"];
      body = (Object.keys(v).length ? '<div class="views">' + order.filter((o) => v[o]).map((o) => '<div><img src="' + esc(v[o]) + '"><div class="cap">' + o + '</div></div>').join("") + "</div>" : (j.thumbnail ? '<div class="grid"><div class="card"><img src="' + esc(j.thumbnail) + '"></div></div>' : ""))
        + '<div class="acts2"><button class="primary" data-a="approveModel">Approve · upload and insert</button><button data-a="denyModel">Reject</button></div>';
    }
    if (j.status === "uploading") body = '<div class="bar"><i style="width:70%"></i></div><div class="s">uploading to Roblox…</div>';
    if (j.status === "done") body = '<div class="s">Roblox asset ' + esc(j.robloxAssetId) + ' · inserted into Studio</div><div class="acts2"><button data-a="insert">Insert again</button><button data-a="open">Show files</button></div>';
    const refs = j.refs && j.refs.length ? '<div class="refs">' + j.refs.slice(0, 5).map((r) => '<img src="' + esc(r) + '">').join("") + "</div>" : "";
    return '<div class="job" data-id="' + esc(j.id) + '"><div class="t">' + esc(j.prompt) + '</div><div class="s">' + esc(j.status) + (j.note ? " · " + esc(j.note) : "") + '</div>' + (j.status === "drafting" || j.status === "drafts" ? refs : "") + body
      + (j.error ? '<div class="err">' + esc(j.error) + "</div>" : "") + '<div class="acts2"><button data-a="remove">Remove</button></div></div>';
  }).join("");
  document.querySelectorAll(".job button").forEach((b) => b.onclick = () => vs.postMessage({ type: b.dataset.a, id: b.closest(".job").dataset.id, index: b.dataset.i !== undefined ? Number(b.dataset.i) : undefined }));
}
window.addEventListener("message", (e) => { if (e.data.type === "state") render(e.data); });
vs.postMessage({ type: "refresh" });
</script></body></html>`;
	}
}

// ---- helpers -------------------------------------------------------------------------------------

async function save(url: string, file: string) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`download ${r.status} for ${path.basename(file)}`);
	fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

export function slugOf(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
}

// One screenshot from the open Studio through Roblox's own MCP server (stdio JSON-RPC). The Studio seat is
// exclusive per machine: while Claude Code holds it this fails fast and the drafts use the reference folder.
function studioCapture(outFile: string): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const bat = path.join(process.env.LOCALAPPDATA ?? "", "Roblox", "mcp.bat");
		if (!fs.existsSync(bat)) return resolve(undefined);
		const child = spawn("cmd.exe", ["/d", "/s", "/c", bat], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
		let buf = ""; let nextId = 1; const pending = new Map<number, (v: any) => void>();
		const call = (method: string, params: any) => new Promise<any>((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
		const done = (v: string | undefined, err?: Error) => { clearTimeout(t); child.kill(); err ? reject(err) : resolve(v); };
		const t = setTimeout(() => done(undefined, new Error("Studio MCP timed out")), 20000);
		child.on("error", (e) => done(undefined, e));
		child.stdout.on("data", (d) => {
			buf += d.toString();
			let i; while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
				if (!line) continue;
				try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); } } catch { /* not json */ }
			}
		});
		(async () => {
			await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "drydock-ide", version: "0.0.4" } });
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
			const studios = await call("tools/call", { name: "list_roblox_studios", arguments: {} });
			const text = JSON.stringify(studios.result ?? {});
			const idMatch = /"(?:id|studio_id|instanceId)"\s*:\s*"?([A-Za-z0-9_-]+)"?/.exec(text);
			if (!idMatch) return done(undefined);
			const shot = await call("tools/call", { name: "screen_capture", arguments: { studio_id: idMatch[1] } });
			const img = (shot.result?.content ?? []).find((c: any) => c.type === "image" && c.data);
			if (!img) return done(undefined);
			fs.writeFileSync(outFile, Buffer.from(img.data, "base64"));
			done(outFile);
		})().catch((e) => done(undefined, e));
	});
}
