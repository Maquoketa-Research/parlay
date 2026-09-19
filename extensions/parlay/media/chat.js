// Parlay chat: the page's script. It owns nothing: the extension (src/chat.ts) posts the whole state after every
// change ({type:"state", entries, agent, busy, names}) and the page redraws; typing, Stop, the picker and New go
// back as messages. Redrawing everything is fine at chat sizes (a few hundred entries).
const vs = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Markdown, the hand-written subset the agents actually write: fenced code, headings, bullet and numbered lists,
// paragraphs; inline code, bold, italics, links. Everything is escaped first, so the agents' text is never HTML.
function md(src) {
	const out = [], lines = String(src).replace(/\r/g, "").split("\n");
	let para = [], list = null, i = 0;
	const flush = () => { if (para.length) { out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`); para = []; } if (list) { out.push(`</${list}>`); list = null; } };
	while (i < lines.length) {
		const l = lines[i];
		const fence = /^\s*```(\w*)\s*$/.exec(l);
		if (fence) {
			flush();
			const code = [];
			for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
			out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); i++; continue;
		}
		const h = /^(#{1,3})\s+(.*)$/.exec(l), li = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(l);
		if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
		else if (li) { const kind = li[1] ? "ol" : "ul"; if (list !== kind) { flush(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); }
		else if (!l.trim()) flush();
		else { if (list) flush(); para.push(l); }
		i++;
	}
	flush();
	return out.join("");
}
function inline(s) {
	return esc(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

let state = { entries: [], agent: "claude", busy: false, names: { claude: "Claude", gpt: "GPT" } };
const opened = new Set();   // tool cards the user expanded (by index: the transcript only grows, New clears it)

function render() {
	const log = $("log"), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
	const rows = state.entries.map((e, i) => {
		if (e.kind === "user") return `<div class="m user"><div class="b">${md(e.text)}</div></div>`;
		if (e.kind === "assistant") return `<div class="m ai"><div class="who">${esc(state.names[e.agent] ?? e.agent)}</div><div class="b${e.open ? " cur" : ""}">${md(e.text)}</div></div>`;
		if (e.kind === "tool") return `<details class="tool${e.error ? " err" : ""}" data-i="${i}"${opened.has(i) ? " open" : ""}><summary><span class="n">${esc(e.name)}</span>${esc(e.text)}</summary><pre>${esc(e.detail || "")}</pre></details>`;
		return `<div class="sys">${esc(e.text)}</div>`;
	});
	const last = state.entries[state.entries.length - 1];
	if (state.busy && !(last && last.kind === "assistant" && last.open)) rows.push(`<div class="m ai"><div class="b think"><i></i><i></i><i></i></div></div>`);
	if (!rows.length) rows.push(`<div class="empty">Ask ${esc(state.names[state.agent])} about this place. Switch models above at any time: the other one picks the conversation up.</div>`);
	log.innerHTML = rows.join("");
	log.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => { const k = Number(d.dataset.i); if (d.open) opened.add(k); else opened.delete(k); }));
	if (stick) log.scrollTop = log.scrollHeight;
	document.querySelectorAll(".pick button").forEach((b) => { b.classList.toggle("on", b.dataset.a === state.agent); b.disabled = state.busy; });
	$("stop").hidden = !state.busy; $("go").hidden = state.busy;
	$("in").placeholder = `Message ${state.names[state.agent]}…`;
}

function send() {
	const box = $("in"), text = box.value.trim();
	if (!text || state.busy) return;
	vs.postMessage({ type: "send", text });
	box.value = ""; box.style.height = "auto";
}

window.addEventListener("message", (e) => { if (e.data?.type === "state") { if (!e.data.entries.length) opened.clear(); state = e.data; render(); } });
$("in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("in").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; });
$("go").onclick = send;
$("stop").onclick = () => vs.postMessage({ type: "stop" });
document.querySelectorAll(".pick button").forEach((b) => b.onclick = () => vs.postMessage({ type: "use", agent: b.dataset.a }));
vs.postMessage({ type: "ready" });
