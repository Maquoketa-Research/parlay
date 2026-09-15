// The Meshy tab: a prompt or a reference image goes to Meshy, a textured 3D model comes back, lands in the
// workspace's assets folder, goes up to Roblox through the Open Cloud Assets API as a Model, and a Claude
// skill inserts it into the open Studio. Keys live in SecretStorage, never in settings files.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const MESHY = "https://api.meshy.ai";
const ROBLOX = "https://apis.roblox.com/assets/v1";
const KEY_MESHY = "drydock.meshyApiKey";
const KEY_ROBLOX = "drydock.robloxApiKey";

export interface MeshyTask {
	id: string;
	kind: "preview" | "refine" | "image";
	prompt: string;
	status: string;          // PENDING | IN_PROGRESS | SUCCEEDED | FAILED | CANCELED
	progress: number;
	thumbnail?: string;
	modelUrls?: Record<string, string>;
	error?: string;
	createdAt: number;
	previewId?: string;      // refine tasks point at their preview
	file?: string;           // local .glb once downloaded
	robloxOp?: string;       // operations/<id> while the upload is processing
	robloxAssetId?: string;
	robloxError?: string;
}

export class MeshyView implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private tasks: MeshyTask[];
	private timer?: NodeJS.Timeout;

	constructor(private ctx: vscode.ExtensionContext, private insert: (assetId: string, name: string) => Promise<void>) {
		this.tasks = ctx.globalState.get<MeshyTask[]>("meshyTasks", []);
	}

	// ---- keys and settings -------------------------------------------------------------------------

	async setKey(which: "meshy" | "roblox") {
		const v = await vscode.window.showInputBox({
			prompt: which === "meshy" ? "Meshy API key (meshy.ai, Settings, API Keys)" : "Roblox Open Cloud API key with Assets read and write",
			password: true, ignoreFocusOut: true,
		});
		if (v === undefined) return;
		await this.ctx.secrets.store(which === "meshy" ? KEY_MESHY : KEY_ROBLOX, v.trim());
		void this.push();
	}

	private async keys() {
		return { meshy: !!(await this.ctx.secrets.get(KEY_MESHY)), roblox: !!(await this.ctx.secrets.get(KEY_ROBLOX)) };
	}

	private cfg<T>(k: string, d: T): T { return vscode.workspace.getConfiguration("drydock").get<T>(k, d); }

	// ---- the view ----------------------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
		view.onDidChangeVisibility(() => { if (view.visible) void this.push(); });
		view.onDidDispose(() => { this.view = undefined; });
		void this.push();
		this.schedule();
	}

	private async onMessage(m: { type: string; [k: string]: unknown }) {
		try {
			switch (m.type) {
				case "generate": await this.generate(String(m.prompt ?? ""), String(m.image ?? ""), String(m.model ?? "latest"), !!m.pbr); break;
				case "refine": await this.refine(String(m.id)); break;
				case "download": await this.download(String(m.id)); break;
				case "upload": await this.upload(String(m.id)); break;
				case "insert": { const t = this.find(String(m.id)); if (t?.robloxAssetId) await this.insert(t.robloxAssetId, slug(t.prompt)); break; }
				case "remove": this.tasks = this.tasks.filter((t) => t.id !== m.id); await this.save(); break;
				case "open": { const t = this.find(String(m.id)); if (t?.file) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(t.file)); break; }
				case "browse": {
					const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Images: ["png", "jpg", "jpeg"] }, title: "Reference image for Meshy" });
					if (pick?.[0]) void this.view?.webview.postMessage({ type: "image", path: pick[0].fsPath });
					break;
				}
				case "setKey": await this.setKey(m.which === "roblox" ? "roblox" : "meshy"); break;
				case "settings": await vscode.commands.executeCommand("workbench.action.openSettings", "drydock.roblox"); break;
				case "refresh": await this.poll(); break;
			}
		} catch (e) {
			void vscode.window.showErrorMessage(`Meshy: ${(e as Error).message}`);
		}
		await this.push();
	}

	private find(id: string) { return this.tasks.find((t) => t.id === id); }
	private async save() { await this.ctx.globalState.update("meshyTasks", this.tasks); }

	private async push() {
		if (!this.view) return;
		void this.view.webview.postMessage({
			type: "state", tasks: this.tasks, keys: await this.keys(),
			creator: `${this.cfg("robloxCreatorType", "user")} ${this.cfg("robloxCreatorId", "") || "(not set)"}`,
		});
	}

	// ---- Meshy -------------------------------------------------------------------------------------

	private async meshy(method: string, p: string, body?: unknown): Promise<any> {
		const key = await this.ctx.secrets.get(KEY_MESHY);
		if (!key) throw new Error("no Meshy API key. Use the Set key link in the Meshy tab.");
		const r = await fetch(MESHY + p, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		const text = await r.text();
		if (!r.ok) throw new Error(`Meshy ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	private async generate(prompt: string, image: string, model: string, pbr: boolean) {
		if (!prompt.trim() && !image.trim()) throw new Error("write a prompt or pick a reference image");
		const polycount = this.cfg("meshyPolycount", 10000);
		let id: string, kind: MeshyTask["kind"];
		if (image.trim()) {
			const buf = fs.readFileSync(image.trim());
			const mime = image.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
			const res = await this.meshy("POST", "/openapi/v1/image-to-3d", {
				image_url: `data:${mime};base64,${buf.toString("base64")}`, ai_model: model, should_texture: true, enable_pbr: pbr,
				should_remesh: true, target_polycount: polycount, target_formats: ["glb", "fbx"], texture_prompt: prompt.trim() || undefined,
			});
			id = res.result; kind = "image";
		} else {
			const res = await this.meshy("POST", "/openapi/v2/text-to-3d", {
				mode: "preview", prompt: prompt.trim(), ai_model: model, should_remesh: true, target_polycount: polycount, target_formats: ["glb", "fbx"],
			});
			id = res.result; kind = "preview";
		}
		this.tasks.unshift({ id, kind, prompt: prompt.trim() || path.basename(image), status: "PENDING", progress: 0, createdAt: Date.now() });
		await this.save(); this.schedule();
	}

	private async refine(previewId: string) {
		const pv = this.find(previewId); if (!pv) return;
		const res = await this.meshy("POST", "/openapi/v2/text-to-3d", { mode: "refine", preview_task_id: previewId, enable_pbr: true, target_formats: ["glb", "fbx"] });
		this.tasks.unshift({ id: res.result, kind: "refine", prompt: pv.prompt, status: "PENDING", progress: 0, createdAt: Date.now(), previewId });
		await this.save(); this.schedule();
	}

	private schedule() {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll(), 4000);
	}

	private async poll() {
		const live = this.tasks.filter((t) => t.status === "PENDING" || t.status === "IN_PROGRESS" || (t.robloxOp && !t.robloxAssetId && !t.robloxError));
		if (!live.length) { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } return; }
		for (const t of live) {
			try {
				if (t.status === "PENDING" || t.status === "IN_PROGRESS") {
					const r = await this.meshy("GET", t.kind === "image" ? `/openapi/v1/image-to-3d/${t.id}` : `/openapi/v2/text-to-3d/${t.id}`);
					t.status = r.status; t.progress = r.progress ?? t.progress; t.thumbnail = r.thumbnail_url ?? t.thumbnail;
					t.modelUrls = r.model_urls ?? t.modelUrls; t.error = r.task_error?.message;
				}
				if (t.robloxOp && !t.robloxAssetId) await this.pollUpload(t);
			} catch (e) { t.error = (e as Error).message; }
		}
		await this.save(); await this.push();
	}

	// ---- files -------------------------------------------------------------------------------------

	private assetsDir(): string {
		const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Documents");
		const dir = path.join(ws, this.cfg("assetsDir", "assets/meshy"));
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	private async download(id: string) {
		const t = this.find(id); if (!t?.modelUrls?.glb) throw new Error("no model yet");
		const base = path.join(this.assetsDir(), `${slug(t.prompt)}-${t.id.slice(-6)}`);
		await save(t.modelUrls.glb, base + ".glb");
		if (t.modelUrls.fbx) await save(t.modelUrls.fbx, base + ".fbx");
		if (t.thumbnail) await save(t.thumbnail, base + ".png");
		t.file = base + ".glb";
		await this.save();
		void vscode.window.showInformationMessage(`Meshy: saved ${path.basename(t.file)} to ${path.dirname(t.file)}`);
	}

	// ---- Roblox ------------------------------------------------------------------------------------

	private async roblox(method: string, p: string, body?: FormData): Promise<any> {
		const key = await this.ctx.secrets.get(KEY_ROBLOX);
		if (!key) throw new Error("no Roblox Open Cloud key. Use the Set key link in the Meshy tab.");
		const r = await fetch(ROBLOX + p, { method, headers: { "x-api-key": key }, body });
		const text = await r.text();
		if (!r.ok) throw new Error(`Roblox ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	private async upload(id: string) {
		const t = this.find(id); if (!t) return;
		if (!t.file) await this.download(id);
		const creatorId = this.cfg("robloxCreatorId", "");
		if (!creatorId) throw new Error("set drydock.robloxCreatorId (your user id or group id) first");
		const creator = this.cfg<string>("robloxCreatorType", "user") === "group" ? { groupId: creatorId } : { userId: creatorId };
		const form = new FormData();
		form.append("request", JSON.stringify({ assetType: "Model", displayName: t.prompt.slice(0, 50) || "Meshy model", description: `Meshy ${t.kind} ${t.id}`, creationContext: { creator } }));
		form.append("fileContent", new Blob([fs.readFileSync(t.file!)], { type: "model/gltf-binary" }), path.basename(t.file!));
		const res = await this.roblox("POST", "/assets", form);
		t.robloxOp = res.path; t.robloxError = undefined; t.robloxAssetId = undefined;
		await this.save(); this.schedule();
	}

	private async pollUpload(t: MeshyTask) {
		if (!t.robloxOp) return;
		const r = await this.roblox("GET", "/" + t.robloxOp);
		if (r.done) {
			if (r.response?.assetId) { t.robloxAssetId = String(r.response.assetId); }
			else { t.robloxError = r.error?.message ?? JSON.stringify(r).slice(0, 200); }
		}
	}

	// ---- html --------------------------------------------------------------------------------------

	private html(webview: vscode.Webview): string {
		const nonce = Math.random().toString(36).slice(2);
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;padding:10px 12px;font:13px/1.45 var(--vscode-font-family);color:var(--vscode-foreground);background:transparent}
textarea,input,select{width:100%;box-sizing:border-box;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:8px;padding:6px 8px;font:inherit}
textarea{min-height:56px;resize:vertical}
.row{display:flex;gap:8px;align-items:center;margin-top:8px}
.row>*{flex:1}
button{border:0;border-radius:999px;padding:5px 12px;font:inherit;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button:disabled{opacity:.5;cursor:default}
.keys{margin-top:8px;font-size:12px;color:var(--vscode-descriptionForeground)}
.keys a{color:var(--vscode-textLink-foreground);cursor:pointer;margin-left:6px}
.task{display:grid;grid-template-columns:72px 1fr;gap:10px;padding:10px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.25))}
.task img,.task .ph{width:72px;height:72px;border-radius:10px;object-fit:cover;background:var(--vscode-editorWidget-background)}
.task .t{font-weight:600}
.task .s{font-size:12px;color:var(--vscode-descriptionForeground)}
.task .err{font-size:12px;color:var(--vscode-errorForeground)}
.bar{height:3px;border-radius:2px;background:var(--vscode-progressBar-background);opacity:.35;margin:6px 0}
.bar>i{display:block;height:100%;border-radius:2px;background:var(--vscode-progressBar-background);opacity:1}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.acts button{padding:3px 10px;font-size:12px}
.empty{color:var(--vscode-descriptionForeground);padding:18px 0;text-align:center}
</style></head><body>
<textarea id="prompt" placeholder="A weathered brass lighthouse lamp, low-poly, game-ready"></textarea>
<div class="row"><input id="image" placeholder="Reference image (optional)"><button id="browse" style="flex:0 0 auto">Browse</button></div>
<div class="row">
  <select id="model"><option value="latest">Meshy latest</option><option value="meshy-7">meshy-7</option><option value="meshy-6">meshy-6</option><option value="meshy-6-lite">meshy-6-lite (cheap)</option></select>
  <label style="flex:0 0 auto"><input type="checkbox" id="pbr" style="width:auto"> PBR</label>
  <button id="go" class="primary" style="flex:0 0 auto">Generate</button>
</div>
<div class="keys" id="keys"></div>
<div id="list"></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
$("go").onclick = () => vs.postMessage({ type: "generate", prompt: $("prompt").value, image: $("image").value, model: $("model").value, pbr: $("pbr").checked });
$("browse").onclick = () => vs.postMessage({ type: "browse" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function render(st) {
  $("keys").innerHTML = "Meshy key: " + (st.keys.meshy ? "set" : "missing") + '<a data-k="meshy">Set</a> · Roblox key: ' + (st.keys.roblox ? "set" : "missing") + '<a data-k="roblox">Set</a> · Creator: ' + esc(st.creator) + '<a data-s="1">Settings</a>';
  document.querySelectorAll("#keys a[data-k]").forEach((a) => a.onclick = () => vs.postMessage({ type: "setKey", which: a.dataset.k }));
  document.querySelectorAll("#keys a[data-s]").forEach((a) => a.onclick = () => vs.postMessage({ type: "settings" }));
  if (!st.tasks.length) { $("list").innerHTML = '<div class="empty">Nothing generated yet. Describe a prop, or pick a reference image, and press Generate.</div>'; return; }
  $("list").innerHTML = st.tasks.map((t) => {
    const done = t.status === "SUCCEEDED", live = t.status === "PENDING" || t.status === "IN_PROGRESS";
    const acts = [];
    if (done && t.kind === "preview") acts.push('<button data-a="refine">Refine + texture</button>');
    if (done) acts.push('<button data-a="download">' + (t.file ? "Re-download" : "Download") + '</button>');
    if (t.file) acts.push('<button data-a="open">Show file</button>');
    if (done && t.kind !== "preview") acts.push('<button data-a="upload"' + (t.robloxOp && !t.robloxAssetId && !t.robloxError ? " disabled" : "") + '>' + (t.robloxAssetId ? "Re-upload" : "Upload to Roblox") + '</button>');
    if (t.robloxAssetId) acts.push('<button data-a="insert" class="primary">Insert in Studio</button>');
    acts.push('<button data-a="remove">Remove</button>');
    const status = live ? t.status.toLowerCase().replace("_", " ") + " · " + (t.progress || 0) + "%" : t.status.toLowerCase();
    const rbx = t.robloxAssetId ? " · Roblox asset " + esc(t.robloxAssetId) : t.robloxOp && !t.robloxError ? " · uploading to Roblox…" : "";
    return '<div class="task" data-id="' + esc(t.id) + '">' + (t.thumbnail ? '<img src="' + esc(t.thumbnail) + '">' : '<div class="ph"></div>') +
      '<div><div class="t">' + esc(t.prompt) + '</div><div class="s">' + esc(t.kind) + " · " + status + rbx + "</div>" +
      (live ? '<div class="bar"><i style="width:' + (t.progress || 0) + '%"></i></div>' : "") +
      (t.error ? '<div class="err">' + esc(t.error) + "</div>" : "") + (t.robloxError ? '<div class="err">' + esc(t.robloxError) + "</div>" : "") +
      '<div class="acts">' + acts.join("") + "</div></div></div>";
  }).join("");
  document.querySelectorAll(".task button").forEach((b) => b.onclick = () => vs.postMessage({ type: b.dataset.a, id: b.closest(".task").dataset.id }));
}
window.addEventListener("message", (e) => { const m = e.data; if (m.type === "state") render(m); if (m.type === "image") $("image").value = m.path; });
vs.postMessage({ type: "refresh" });
</script></body></html>`;
	}
}

async function save(url: string, file: string) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`download ${r.status} for ${path.basename(file)}`);
	fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

export function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "asset";
}
