// The Meshy tab, as a workflow. Describe a prop; the game's own screenshots set the style; an image model drafts
// a few concepts; approve one; Meshy turns it into an untextured mesh (triangles capped for Roblox); the mesh
// spins in a viewport; approve the shape; the viewport renders it from six angles onto one sheet, the image model
// paints the sheet in the game's look, and the paint is projected back onto the mesh as its texture (Meshy's own
// textures are not used); approve the textured model and it uploads to Roblox through Open Cloud and a Claude
// skill inserts it into the open Studio. Keys live in SecretStorage, never in settings files.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { cloudAuth, listStudios, studioSession } from "./studio";

const MESHY = "https://api.meshy.ai";
const ROBLOX = "https://apis.roblox.com/assets/v1";
const OPENAI = "https://api.openai.com/v1";
const KEYS = { meshy: "parlay.meshyApiKey", roblox: "parlay.robloxApiKey", openai: "parlay.openaiApiKey" } as const;
type KeyName = keyof typeof KEYS;

export interface Job {
	id: string;
	prompt: string;
	slug: string;
	dir: string;                 // <workspace>/<assetsDir>/<slug>-<id>
	createdAt: number;
	status: "drafting" | "drafts" | "modeling" | "review" | "painting" | "textured" | "uploading" | "done" | "failed";
	refs: string[];              // reference screenshots used for the drafts and the paint
	drafts: string[];            // draft PNG paths
	chosen?: number;             // index into drafts
	meshyId?: string;
	progress?: number;
	thumbnail?: string;
	mesh?: string;               // untextured .glb from Meshy
	sheet?: string;              // six clay renders of the mesh on one sheet (from the viewport)
	paint?: string;              // the same sheet, painted by the image model
	texture?: string;            // the paint projected onto the mesh's UVs
	file?: string;               // textured .glb, what goes to Roblox
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
		const prompts = { meshy: "Meshy API key (meshy.ai, Settings, API Keys)", roblox: "Roblox Open Cloud API key with Assets read and write", openai: "OpenAI API key (concept drafts and texture painting)" };
		const v = await vscode.window.showInputBox({ prompt: prompts[which], password: true, ignoreFocusOut: true });
		if (v === undefined) return;
		await this.ctx.secrets.store(KEYS[which], v.trim());
		void this.push();
	}

	private async key(which: KeyName): Promise<string | undefined> {
		return (await this.ctx.secrets.get(KEYS[which])) || (which === "openai" ? process.env.OPENAI_API_KEY : undefined);
	}

	private cfg<T>(k: string, d: T): T { return vscode.workspace.getConfiguration("parlay").get<T>(k, d); }
	private ws(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(process.env.USERPROFILE ?? ".", "Documents"); }
	private assetsRoot(): string { const d = path.join(this.ws(), this.cfg("assetsDir", "assets/meshy")); fs.mkdirSync(d, { recursive: true }); return d; }

	// ---- the view ----------------------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(this.assetsRoot()), vscode.Uri.file(this.ws()), vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
		view.onDidChangeVisibility(() => { if (view.visible) void this.push(); });
		view.onDidDispose(() => { this.view = undefined; });
		void this.push();
		this.schedule();
	}

	private async onMessage(m: { type: string; id?: string; index?: number; prompt?: string; which?: string; png?: string; glb?: string; error?: string }) {
		const job = m.id ? this.jobs.find((j) => j.id === m.id) : undefined;
		try {
			switch (m.type) {
				case "draft": await this.draft(String(m.prompt ?? "")); break;
				case "approveDraft": if (job) await this.approveDraft(job, Number(m.index)); break;
				case "denyDraft": if (job) { job.drafts.splice(Number(m.index), 1); if (!job.drafts.length) { job.status = "failed"; job.error = "every draft was rejected; try a different description"; } } break;
				case "approveShape": if (job) await this.approveShape(job); break;
				case "sheet": if (job && m.png) { job.sheet = path.join(job.dir, "views.png"); fs.writeFileSync(job.sheet, Buffer.from(m.png, "base64")); await this.paint(job); } break;
				case "baked": if (job && m.glb && m.png) {
					job.texture = path.join(job.dir, "texture.png"); fs.writeFileSync(job.texture, Buffer.from(m.png, "base64"));
					job.file = path.join(job.dir, "model.glb"); fs.writeFileSync(job.file, Buffer.from(m.glb, "base64"));
					job.status = "textured"; job.note = undefined;
				} break;
				case "viewerError": if (job) { job.error = m.error; if (job.status === "painting") job.status = "review"; } break;
				case "repaint": if (job) { job.paint = job.texture = job.file = undefined; job.error = undefined; job.status = "painting"; await this.paint(job); } break;
				case "approveModel": if (job) await this.approveModel(job); break;
				case "denyModel": if (job) { job.status = "drafts"; job.meshyId = job.mesh = job.sheet = job.paint = job.texture = job.file = job.thumbnail = undefined; job.note = "model rejected; pick another draft"; } break;
				case "insert": if (job?.robloxAssetId) await this.insert(job.robloxAssetId, job.prompt); break;
				case "open": if (job) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(job.file ?? job.dir)); break;
				case "remove": this.jobs = this.jobs.filter((j) => j !== job); break;
				case "setKey": await this.setKey((m.which as KeyName) ?? "meshy"); break;
				case "settings": await vscode.commands.executeCommand("workbench.action.openSettings", "parlay."); break;
				case "refresh": await this.poll(); break;
			}
		} catch (e) {
			if (job) { job.error = (e as Error).message; if (job.status === "drafting") job.status = "failed"; if (job.status === "painting") job.status = "review"; }
			else void vscode.window.showErrorMessage(`Meshy: ${(e as Error).message}`);
		}
		await this.save(); await this.push();
	}

	private async save() { await this.ctx.globalState.update("meshyJobs", this.jobs); }

	private async push() {
		if (!this.view) return;
		const w = this.view.webview;
		const uri = (p?: string) => (!p ? undefined : p.startsWith("http") ? p : w.asWebviewUri(vscode.Uri.file(p)).toString());
		void w.postMessage({
			type: "state",
			jobs: this.jobs.map((j) => ({ ...j, drafts: j.drafts.map((d) => uri(d)), refs: j.refs.map((r) => uri(r)), thumbnail: uri(j.thumbnail), mesh: uri(j.mesh), paint: uri(j.paint), texture: uri(j.texture) })),
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

	// One call to the images API: generations without references, edits with them (image[] carries the
	// references and, for the paint, the sheet). Returns the PNGs it wrote.
	private async images(job: Job, prompt: string, opts: { n: number; size: string; quality: string; images: string[]; name: (i: number) => string }): Promise<string[]> {
		const key = await this.key("openai");
		if (!key) throw new Error("no OpenAI API key (Parlay: Set OpenAI API key), and OPENAI_API_KEY is not set");
		const model = this.cfg("imageModel", "gpt-image-2.5-sunburst");
		let res: Response;
		if (opts.images.length) {
			const form = new FormData();
			form.append("model", model); form.append("n", String(opts.n)); form.append("size", opts.size); form.append("quality", opts.quality); form.append("prompt", prompt);
			for (const r of opts.images) form.append("image[]", new Blob([fs.readFileSync(r)], { type: r.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" }), path.basename(r));
			res = await fetch(`${OPENAI}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
		} else {
			res = await fetch(`${OPENAI}/images/generations`, {
				method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model, prompt, n: opts.n, size: opts.size, quality: opts.quality }),
			});
		}
		const text = await res.text();
		if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
		const data = JSON.parse(text).data as { b64_json?: string; url?: string }[];
		const out: string[] = [];
		for (const [i, d] of data.entries()) {
			const file = path.join(job.dir, opts.name(i));
			if (d.b64_json) fs.writeFileSync(file, Buffer.from(d.b64_json, "base64"));
			else if (d.url) await save(d.url, file);
			else continue;
			out.push(file);
		}
		if (!out.length) throw new Error("the image model returned no images");
		return out;
	}

	private openaiDrafts(job: Job): Promise<string[]> {
		const base = `Concept art for a Roblox game prop: ${job.prompt}. One object only, centred, three-quarter view, plain neutral background, no text, no people, no hands.`;
		const prompt = job.refs.length
			? `${base} Match the look of the reference screenshots exactly: same colour palette, material language, level of detail and lighting mood, so it belongs in that world.`
			: `${base} Stylised, game-ready, readable silhouette.`;
		return this.images(job, prompt, { n: 3, size: "1024x1024", quality: "medium", images: job.refs, name: (i) => `draft-${i + 1}.png` });
	}

	// ---- step 2: the mesh --------------------------------------------------------------------------

	private async meshy(method: string, p: string, body?: unknown): Promise<any> {
		const key = await this.key("meshy");
		if (!key) throw new Error("no Meshy API key (Parlay: Set Meshy API key)");
		const r = await fetch(MESHY + p, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
		const text = await r.text();
		if (!r.ok) throw new Error(`Meshy ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	// Mesh only: Meshy's textures are not used (the paint step replaces them), so it is faster and cheaper.
	private async approveDraft(job: Job, index: number) {
		const file = job.drafts[index]; if (!file) return;
		job.chosen = index; job.error = undefined; job.note = undefined;
		const buf = fs.readFileSync(file);
		const res = await this.meshy("POST", "/openapi/v1/image-to-3d", {
			image_url: `data:image/png;base64,${buf.toString("base64")}`,
			ai_model: this.cfg("meshyModel", "latest"), should_texture: false,
			should_remesh: true, target_polycount: this.cfg("meshyPolycount", 20000), topology: "triangle", target_formats: ["glb"],
			multi_view_thumbnails: true, image_enhancement: true,
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
					if (r.status === "SUCCEEDED") {
						if (!r.model_urls?.glb) throw new Error("Meshy finished without a glb");
						const mesh = path.join(j.dir, "mesh.glb");
						await save(r.model_urls.glb, mesh);
						j.mesh = mesh; j.status = "review"; j.note = "turn it around; approve the shape to paint it";
					} else if (r.status === "FAILED" || r.status === "CANCELED") { j.status = "failed"; j.error = r.task_error?.message ?? `Meshy task ${r.status.toLowerCase()}`; }
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

	// ---- step 3: the paint -------------------------------------------------------------------------

	// The viewport renders the sheet (message "sheet") when it sees status painting without one; with a sheet
	// already on disk (a repaint, or a retry) the image model is called straight away.
	private async approveShape(job: Job) {
		if (!job.mesh) throw new Error("no mesh yet");
		job.error = undefined; job.status = "painting"; job.paint = job.texture = job.file = undefined;
		if (job.sheet && fs.existsSync(job.sheet)) await this.paint(job);
		else job.note = "rendering six views…";
	}

	private async paint(job: Job) {
		if (!job.sheet) return;
		job.note = "painting the six views…"; await this.save(); await this.push();
		const refs = [job.sheet, ...(job.chosen !== undefined && job.drafts[job.chosen] ? [job.drafts[job.chosen]] : []), ...job.refs.slice(0, 3)];
		const prompt = `The first image is a contact sheet: six renders of one untextured 3D game prop (${job.prompt}) from six camera angles, in a 3 by 2 grid on a flat grey background. `
			+ `Paint the object in every panel as ${job.prompt}, in the look of the concept image and the game screenshots that follow: same palette, materials and level of detail. `
			+ `Keep each panel's silhouette, pose, scale, position and camera exactly as rendered. The same materials and colours in all six panels, flat even lighting, no cast shadows, no highlights that belong to one view only. Leave the grey background untouched. No text.`;
		const [paint] = await this.images(job, prompt, { n: 1, size: "1536x1024", quality: "high", images: refs, name: () => "paint.png" });
		job.paint = paint; job.note = "projecting the paint onto the mesh…";
	}

	// ---- step 4: upload ----------------------------------------------------------------------------

	// as the signed-in Roblox account, else with the stored Open Cloud key (the Assets API takes both)
	private async roblox(method: string, p: string, body?: FormData): Promise<any> {
		const auth = await cloudAuth(this.ctx);
		if (!auth.length) throw new Error("not signed in to Roblox and no Open Cloud key (Parlay: Sign in to Roblox, or Set Roblox Open Cloud API key)");
		let r!: Response, text = "";
		for (let i = 0; i < auth.length; i++) {
			r = await fetch(ROBLOX + p, { method, headers: auth[i], body });
			text = await r.text();
			if (r.ok || !(r.status === 401 || r.status === 403) || i + 1 === auth.length) break;   // a rejected credential moves to the next
		}
		if (!r.ok) throw new Error(`Roblox ${r.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : {};
	}

	private async approveModel(job: Job) {
		if (!job.file) throw new Error("no textured model yet");
		const creatorId = this.cfg("robloxCreatorId", "");
		if (!creatorId) { job.note = `model saved to ${job.dir}; set parlay.robloxCreatorId to upload it to Roblox`; return; }
		const creator = this.cfg<string>("robloxCreatorType", "user") === "group" ? { groupId: creatorId } : { userId: creatorId };
		const form = new FormData();
		form.append("request", JSON.stringify({ assetType: "Model", displayName: job.prompt.slice(0, 50), description: `Parlay: Meshy ${job.meshyId}, painted`, creationContext: { creator } }));
		form.append("fileContent", new Blob([fs.readFileSync(job.file)], { type: "model/gltf-binary" }), "model.glb");
		const res = await this.roblox("POST", "/assets", form);
		job.robloxOp = res.path; job.status = "uploading"; job.error = undefined;
		this.schedule();
	}

	// ---- html --------------------------------------------------------------------------------------

	private html(webview: vscode.Webview): string {
		const nonce = Math.random().toString(36).slice(2);
		const three = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "three")).toString();
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data: blob:; connect-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}">
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
.vp{margin-top:8px;border-radius:10px;overflow:hidden;background:var(--vscode-editorWidget-background);height:240px}
.vp canvas{display:block;width:100%!important;height:240px!important}
.sheet{display:block;width:100%;border-radius:8px;margin-top:8px}
.bar{height:3px;border-radius:2px;background:var(--vscode-progressBar-background);opacity:.35;margin:8px 0 4px}
.bar>i{display:block;height:100%;border-radius:2px;background:var(--vscode-progressBar-background)}
.acts2{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.acts2 button{padding:4px 11px;font-size:12px}
.empty{color:var(--vscode-descriptionForeground);padding:18px 0;text-align:center}
.refs{display:flex;gap:4px;margin-top:6px}
.refs img{width:36px;height:36px;object-fit:cover;border-radius:6px;opacity:.85}
</style>
<script type="importmap" nonce="${nonce}">{"imports":{"three":"${three}/three.module.js","three/addons/":"${three}/jsm/"}}</script>
</head><body>
<textarea id="prompt" placeholder="What does the game need? An axe, a rusted gas pump, a lantern for the dock..."></textarea>
<div class="row"><span class="keys" id="keys" style="flex:1;margin:0"></span><button id="go" class="primary">Draft</button></div>
<div id="list"></div>
<script type="module" nonce="${nonce}">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const vs = acquireVsCodeApi(); const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("go").onclick = () => { vs.postMessage({ type: "draft", prompt: $("prompt").value }); $("prompt").value = ""; };

// ---- the viewport: one WebGL renderer, moved into whichever job is being looked at -------------------
// Everything below works in a normalised space: the mesh is centred and scaled to a 1-unit box, and the six
// cameras are fixed, so the sheet rendered here and the projection later agree exactly.
const DIST = 3, FOV = 30, SHEET = 512, TEX = 2048, DEPTH = 1024;
const CAMS = [[0, 12], [90, 12], [180, 12], [270, 12], [45, 58], [225, -42]];   // azimuth, elevation in degrees
function camFor(i) {
  const a = CAMS[i][0] * Math.PI / 180, e = CAMS[i][1] * Math.PI / 180;
  const c = new THREE.PerspectiveCamera(FOV, 1, DIST - 1.4, DIST + 1.4);
  c.position.set(DIST * Math.cos(e) * Math.sin(a), DIST * Math.sin(e), DIST * Math.cos(e) * Math.cos(a));
  c.lookAt(0, 0, 0); c.updateMatrixWorld(true); c.updateProjectionMatrix(); return c;
}
const clay = new THREE.MeshStandardMaterial({ color: 0x9d9d9d, roughness: 0.9, metalness: 0 });
const viewer = { id: null, url: null, tex: null, meshes: [], busy: new Set() };
viewer.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
viewer.renderer.setPixelRatio(window.devicePixelRatio || 1);
viewer.scene = new THREE.Scene();
viewer.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2, 3, 2); viewer.scene.add(sun);
viewer.root = new THREE.Group(); viewer.scene.add(viewer.root);
viewer.camera = camFor(0); viewer.camera.far = 50; viewer.camera.updateProjectionMatrix();
viewer.controls = new OrbitControls(viewer.camera, viewer.renderer.domElement); viewer.controls.enableDamping = true;
(function loop() { requestAnimationFrame(loop); if (viewer.renderer.domElement.isConnected) { viewer.controls.update(); viewer.renderer.render(viewer.scene, viewer.camera); } })();

async function load(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  viewer.root.clear(); viewer.meshes = []; viewer.tex = null; viewer.source = gltf.scene;
  const box = new THREE.Box3().setFromObject(gltf.scene); const size = box.getSize(new THREE.Vector3()); const centre = box.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const fit = new THREE.Group(); fit.scale.setScalar(s); fit.position.copy(centre).multiplyScalar(-s); fit.add(gltf.scene); viewer.root.add(fit);
  viewer.root.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.uv) { viewer.meshes.push(o); o.material = clay; } });
  if (!viewer.meshes.length) throw new Error("the mesh has no UVs to paint on");
}
function applyTexture(tex) { viewer.tex = tex; const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }); viewer.meshes.forEach((o) => { o.material = m; }); }

// six clay renders on a 3 by 2 sheet, flat grey background
const bake = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); bake.setPixelRatio(1);
function renderSheet() {
  bake.setSize(SHEET, SHEET); bake.setClearColor(0x808080, 1);
  const out = document.createElement("canvas"); out.width = SHEET * 3; out.height = SHEET * 2; const g = out.getContext("2d");
  for (let i = 0; i < 6; i++) { bake.render(viewer.scene, camFor(i)); g.drawImage(bake.domElement, (i % 3) * SHEET, Math.floor(i / 3) * SHEET); }
  return out.toDataURL("image/png").split(",")[1];
}

// project the painted sheet back onto the UVs: for every texel, average the views that see it, weighted by how
// squarely they see it; a view's own depth map rejects texels it cannot see.
async function bakeTexture(paintUrl) {
  const img = new Image(); img.crossOrigin = "anonymous"; img.src = paintUrl; await img.decode();
  const cell = img.width / 3;
  const paints = [], depths = [], cams = [];
  const depthScene = new THREE.Scene(); const depthMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  viewer.meshes.forEach((o) => { const m = new THREE.Mesh(o.geometry, depthMat); m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); depthScene.add(m); });
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("canvas"); c.width = c.height = cell; c.getContext("2d").drawImage(img, (i % 3) * cell, Math.floor(i / 3) * cell, cell, cell, 0, 0, cell, cell);
    const t = new THREE.CanvasTexture(c); paints.push(t);   // raw bytes in, raw bytes out: the bake copies sRGB paint without decoding it
    const rt = new THREE.WebGLRenderTarget(DEPTH, DEPTH, { depthTexture: new THREE.DepthTexture(DEPTH, DEPTH) });
    const cam = camFor(i); cams.push(cam);
    bake.setRenderTarget(rt); bake.setClearColor(0x000000, 1); bake.clear(); bake.render(depthScene, cam); bake.setRenderTarget(null);
    depths.push(rt.depthTexture);
  }
  let frag = "precision highp float; varying vec3 vP; varying vec3 vN; uniform mat4 vp[6]; uniform vec3 cp[6];";
  for (let i = 0; i < 6; i++) frag += "uniform sampler2D paint" + i + "; uniform sampler2D depth" + i + ";";
  frag += "void main(){ vec4 acc = vec4(0.0); vec3 n = normalize(vN);";
  for (let i = 0; i < 6; i++) frag += "{ vec4 clip = vp[" + i + "] * vec4(vP, 1.0); vec3 ndc = clip.xyz / clip.w; vec2 s = ndc.xy * 0.5 + 0.5;"
    + " if (clip.w > 0.0 && s.x > 0.001 && s.x < 0.999 && s.y > 0.001 && s.y < 0.999) { float d = ndc.z * 0.5 + 0.5; float sd = texture2D(depth" + i + ", s).r;"
    + " if (d <= sd + 0.0015) { float w = abs(dot(n, normalize(cp[" + i + "] - vP))); if (w > 0.08) { w = w * w; acc += vec4(texture2D(paint" + i + ", s).rgb * w, w); } } } }";
  frag += " gl_FragColor = acc.a > 0.0 ? vec4(acc.rgb / acc.a, 1.0) : vec4(0.5, 0.5, 0.5, 1.0); }";
  const uniforms = { vp: { value: cams.map((c) => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse)) }, cp: { value: cams.map((c) => c.position.clone()) } };
  for (let i = 0; i < 6; i++) { uniforms["paint" + i] = { value: paints[i] }; uniforms["depth" + i] = { value: depths[i] }; }
  const mat = new THREE.ShaderMaterial({ uniforms, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    vertexShader: "varying vec3 vP; varying vec3 vN; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }",
    fragmentShader: frag });
  const uvScene = new THREE.Scene();
  viewer.meshes.forEach((o) => { const m = new THREE.Mesh(o.geometry, mat); m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); m.frustumCulled = false; uvScene.add(m); });
  const target = new THREE.WebGLRenderTarget(TEX, TEX, { depthBuffer: false });
  bake.setRenderTarget(target); bake.setClearColor(0x808080, 1); bake.clear(); bake.render(uvScene, camFor(0)); bake.setRenderTarget(null);
  const px = new Uint8Array(TEX * TEX * 4); bake.readRenderTargetPixels(target, 0, 0, TEX, TEX, px);
  const out = document.createElement("canvas"); out.width = out.height = TEX; const g = out.getContext("2d"); const id = g.createImageData(TEX, TEX);
  for (let y = 0; y < TEX; y++) id.data.set(px.subarray((TEX - 1 - y) * TEX * 4, (TEX - y) * TEX * 4), y * TEX * 4);   // GL rows are bottom-up
  g.putImageData(id, 0, 0);
  // ponytail: no seam dilation; add a 2 texel pad pass if mip seams show in Studio
  target.dispose(); depths.forEach((d) => d.dispose()); paints.forEach((p) => p.dispose());
  const tex = new THREE.CanvasTexture(out); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = true;
  return { tex, png: out.toDataURL("image/png").split(",")[1] };
}
async function exportGlb() {
  const bin = await new GLTFExporter().parseAsync(viewer.source, { binary: true });
  const bytes = new Uint8Array(bin); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// the state machine on the webview side: whichever job is in review/painting/textured owns the viewport
async function drive(j) {
  const host = document.querySelector('.job[data-id="' + j.id + '"] .vp'); if (!host) return;
  host.appendChild(viewer.renderer.domElement);
  viewer.renderer.setSize(host.clientWidth || 280, 240, false);
  viewer.camera.aspect = (host.clientWidth || 280) / 240; viewer.camera.updateProjectionMatrix();
  try {
    if (viewer.url !== j.mesh) { viewer.url = j.mesh; viewer.id = j.id; await load(j.mesh); }
    if (j.status === "painting" && !j.sheet && !viewer.busy.has("sheet:" + j.id)) {
      viewer.busy.add("sheet:" + j.id); vs.postMessage({ type: "sheet", id: j.id, png: renderSheet() });
    }
    if (j.paint && !j.texture && !viewer.busy.has("bake:" + j.paint)) {
      viewer.busy.add("bake:" + j.paint);
      const { tex, png } = await bakeTexture(j.paint); applyTexture(tex);
      vs.postMessage({ type: "baked", id: j.id, png, glb: await exportGlb() });
    } else if (j.texture && !viewer.tex) {
      const t = await new THREE.TextureLoader().loadAsync(j.texture); t.colorSpace = THREE.SRGBColorSpace; applyTexture(t);
    } else if (!j.texture && viewer.tex) { viewer.tex = null; viewer.meshes.forEach((o) => { o.material = clay; }); }
  } catch (e) { vs.postMessage({ type: "viewerError", id: j.id, error: String(e && e.message || e) }); }
}

function render(st) {
  const k = st.keys;
  $("keys").innerHTML = ["openai", "meshy", "roblox"].map((n) => n + ": " + (k[n] ? "set" : '<a data-k="' + n + '">set key</a>')).join(" · ") + ' · creator ' + esc(st.creator) + ' <a data-s="1">settings</a>';
  document.querySelectorAll("#keys a[data-k]").forEach((a) => a.onclick = () => vs.postMessage({ type: "setKey", which: a.dataset.k }));
  document.querySelectorAll("#keys a[data-s]").forEach((a) => a.onclick = () => vs.postMessage({ type: "settings" }));
  if (!st.jobs.length) { $("list").innerHTML = '<div class="empty">Describe a prop and press Draft. Screenshots in <b>' + esc(st.refDir) + '</b> (and a live Studio capture when free) set the style.</div>'; return; }
  const viewportJob = st.jobs.find((j) => j.mesh && (j.status === "review" || j.status === "painting" || j.status === "textured"));
  $("list").innerHTML = st.jobs.map((j) => {
    let body = "";
    const vp = j === viewportJob ? '<div class="vp"></div>' : "";
    if (j.status === "drafting") body = '<div class="bar"><i style="width:35%"></i></div><div class="s">drafting concept images…</div>';
    if (j.status === "drafts") body = '<div class="grid">' + j.drafts.map((d, i) => '<div class="card"><img src="' + esc(d) + '"><div class="acts"><button class="primary" data-a="approveDraft" data-i="' + i + '">Use</button><button data-a="denyDraft" data-i="' + i + '">No</button></div></div>').join("") + "</div>";
    if (j.status === "modeling") body = '<div class="bar"><i style="width:' + (j.progress || 2) + '%"></i></div><div class="s">Meshy is modelling · ' + (j.progress || 0) + '%</div>' + (j.thumbnail ? '<div class="grid"><div class="card"><img src="' + esc(j.thumbnail) + '"></div></div>' : "");
    if (j.status === "review") body = vp + '<div class="acts2"><button class="primary" data-a="approveShape">Approve shape · paint it</button><button data-a="denyModel">Reject</button></div>';
    if (j.status === "painting") body = vp + '<div class="bar"><i style="width:' + (j.paint ? 80 : j.sheet ? 45 : 15) + '%"></i></div>' + (j.paint ? '<img class="sheet" src="' + esc(j.paint) + '">' : "");
    if (j.status === "textured") body = vp + '<div class="acts2"><button class="primary" data-a="approveModel">Approve · upload and insert</button><button data-a="repaint">Repaint</button><button data-a="denyModel">Reject</button></div>';
    if (j.status === "uploading") body = '<div class="bar"><i style="width:70%"></i></div><div class="s">uploading to Roblox…</div>';
    if (j.status === "done") body = '<div class="s">Roblox asset ' + esc(j.robloxAssetId) + ' · inserted into Studio</div><div class="acts2"><button data-a="insert">Insert again</button><button data-a="open">Show files</button></div>';
    const refs = j.refs && j.refs.length ? '<div class="refs">' + j.refs.slice(0, 5).map((r) => '<img src="' + esc(r) + '">').join("") + "</div>" : "";
    return '<div class="job" data-id="' + esc(j.id) + '"><div class="t">' + esc(j.prompt) + '</div><div class="s">' + esc(j.status) + (j.note ? " · " + esc(j.note) : "") + '</div>' + (j.status === "drafting" || j.status === "drafts" ? refs : "") + body
      + (j.error ? '<div class="err">' + esc(j.error) + "</div>" : "") + '<div class="acts2"><button data-a="remove">Remove</button></div></div>';
  }).join("");
  document.querySelectorAll(".job button").forEach((b) => b.onclick = () => vs.postMessage({ type: b.dataset.a, id: b.closest(".job").dataset.id, index: b.dataset.i !== undefined ? Number(b.dataset.i) : undefined }));
  if (viewportJob) void drive(viewportJob);
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
async function studioCapture(outFile: string): Promise<string | undefined> {
	const studios = await listStudios();
	if (!studios.length) return undefined;
	return studioSession(async (call) => {
		const shot = await call("tools/call", { name: "screen_capture", arguments: { studio_id: studios[0].id } });
		const img = (shot.result?.content ?? []).find((c: any) => c.type === "image" && c.data);
		if (!img) return undefined;
		fs.writeFileSync(outFile, Buffer.from(img.data, "base64"));
		return outFile;
	});
}
