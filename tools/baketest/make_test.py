"""Build test.html from the webview template in src/meshy.ts: the same viewport script, with the host stubbed.

The stub drives the state machine: a torus knot GLB is built in-page -> status "painting" -> the page renders the
six-view sheet and posts it -> the stub tints each cell a different colour and feeds it back as the paint -> the
page bakes, applies the texture and posts the textured GLB -> the stub reloads that GLB and renders it from the
front and back cameras; the front must read red (cell 0's tint) and the back blue (cell 2's). Files and
result.json land in out/. Run through run.sh.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
IDE = os.path.dirname(os.path.dirname(HERE))
src = open(os.path.join(IDE, "src", "meshy.ts"), encoding="utf-8").read()
start = src.index("<!doctype html>")
end = src.index("</html>`;", start) + len("</html>")
html = src[start:end]
html = html.replace("${nonce}", "x").replace("${three}", "/three").replace("${webview.cspSource}", "http://127.0.0.1:8123 blob:")

stub = r'''<script nonce="x">
const TINT = ["#ff5050", "#50ff50", "#5050ff", "#ffff50", "#ff50ff", "#50ffff"];   // one per sheet cell
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const post = (name, body) => fetch("/save/" + name, { method: "POST", body });
const state = (job) => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", jobs: [job], keys: { openai: true, meshy: true, roblox: true }, creator: "user 1", refDir: "assets/reference" } }));
const decode = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
// share of non-background pixels whose strongest channel is `ch` (0 r, 1 g, 2 b), for a 512 render
function dominance(canvas) {
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; const n = [0, 0, 0]; let total = 0, grey = 0;
  for (let i = 0; i < d.length; i += 16) { const p = [d[i], d[i + 1], d[i + 2]];
    if (Math.abs(p[0] - 128) < 4 && Math.abs(p[1] - 128) < 4 && Math.abs(p[2] - 128) < 4) { grey++; continue; }
    total++; const mx = Math.max(...p); if (mx - Math.min(...p) > 30) n[p.indexOf(mx)]++; }
  return { r: n[0] / total, g: n[1] / total, b: n[2] / total, background: grey / (grey + total) };
}
let job = { id: "t1", prompt: "torus knot", status: "review", refs: [], drafts: [], mesh: null };
window.acquireVsCodeApi = () => ({ postMessage: async (m) => {
  document.body.dataset.last = m.type;
  if (m.type === "refresh") return;
  if (m.type === "viewerError") { await post("result.json", JSON.stringify({ ok: false, error: m.error })); document.title = "error"; return; }
  if (m.type === "sheet") {
    await post("views.png", bytes(m.png));
    const img = await decode("data:image/png;base64," + m.png);
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d");
    g.drawImage(img, 0, 0); g.globalCompositeOperation = "multiply";
    const cell = img.width / 3; for (let i = 0; i < 6; i++) { g.fillStyle = TINT[i]; g.fillRect((i % 3) * cell, Math.floor(i / 3) * cell, cell, cell); }
    const paint = c.toDataURL("image/png"); await post("paint.png", bytes(paint.split(",")[1]));
    job = { ...job, sheet: "/out/views.png", paint }; state(job);
  }
  if (m.type === "baked") {
    await post("texture.png", bytes(m.png)); await post("model.glb", bytes(m.glb));
    const THREE = await import("three"); const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(URL.createObjectURL(new Blob([bytes(m.glb)], { type: "model/gltf-binary" })));
    const box = new THREE.Box3().setFromObject(gltf.scene); const size = box.getSize(new THREE.Vector3()); const centre = box.getCenter(new THREE.Vector3()); const s = 1 / Math.max(size.x, size.y, size.z);
    const fit = new THREE.Group(); fit.scale.setScalar(s); fit.position.copy(centre).multiplyScalar(-s); fit.add(gltf.scene);
    const scene = new THREE.Scene(); scene.add(fit); scene.add(new THREE.AmbientLight(0xffffff, 3));
    const r = new THREE.WebGLRenderer({ preserveDrawingBuffer: true }); r.setSize(512, 512); r.setClearColor(0x808080, 1);
    const cam = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; const c = new THREE.PerspectiveCamera(30, 1, 0.1, 50); c.position.set(3 * Math.cos(e) * Math.sin(a), 3 * Math.sin(e), 3 * Math.cos(e) * Math.cos(a)); c.lookAt(0, 0, 0); return c; };
    const shot = async (name, az) => { r.render(scene, cam(az, 12)); const c = document.createElement("canvas"); c.width = c.height = 512; c.getContext("2d").drawImage(r.domElement, 0, 0); await post(name, bytes(c.toDataURL("image/png").split(",")[1])); return dominance(c); };
    const front = await shot("check-front.png", 0), back = await shot("check-back.png", 180);
    const tex = await decode("data:image/png;base64," + m.png); const tc = document.createElement("canvas"); tc.width = tc.height = 256; tc.getContext("2d").drawImage(tex, 0, 0, 256, 256);
    const unseen = dominance(tc).background;   // texels no view reached keep the grey fallback
    const ok = front.r > 0.8 && back.b > 0.8 && unseen < 0.25;
    await post("result.json", JSON.stringify({ ok, front, back, unseenTexels: unseen }, null, 1));
    document.title = ok ? "done" : "failed";
  }
} });
window.addEventListener("load", async () => {
  const THREE = await import("three"); const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.14, 120, 20), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  const bin = await new GLTFExporter().parseAsync(mesh, { binary: true });
  job.mesh = URL.createObjectURL(new Blob([bin], { type: "model/gltf-binary" }));
  state(job);
  setTimeout(() => { job = { ...job, status: "painting" }; state(job); }, 1500);
});
</script>'''
html = html.replace("</head>", stub + "\n</head>")
open(os.path.join(HERE, "test.html"), "w", encoding="utf-8").write(html)
print("test.html written")
