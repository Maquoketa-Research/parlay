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
		const fence = /^\s*```([^`\s]*)\s*$/.exec(l);
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
 // Protect literal code from subsequent emphasis/link replacements.
 return String(s).split(/(`[^`]+`)/g).map(part => {
  if (part.startsWith("`") && part.endsWith("`")) return `<code>${esc(part.slice(1, -1))}</code>`;
  return esc(part)
   .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
   .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
   .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
 }).join("");
}

let state = { entries: [], agent: "claude", busy: false, names: { claude: "Claude", gpt: "Codex" } };
let pending = false, submitted = "", transcript = "", initialized = false;
const remembered = vs.getState() || {};
const opened = new Set();
const marks = Object.fromEntries([...document.querySelectorAll(".pick button")].map(b => [b.dataset.a, b.querySelector("img").src]));
const prompts = {
 understand: "Give me a quick tour of this project: how it is organized, where gameplay starts, and what I should know before editing.",
 fix: "Help me investigate a bug in this project. Ask me about the issue first, then trace the relevant code.",
 plan: "Help me plan a new feature for this game. Ask what I want to build before making changes.",
};
$("in").value = remembered.draft || "";

function keepDraft() { vs.setState({ draft: $("in").value, conversationId: state.conversationId }); }
function resizeInput() {
 const box = $("in"); box.style.height = "auto"; box.style.height = box.scrollHeight + "px";
 $("latest").style.bottom = document.querySelector("footer").offsetHeight + 12 + "px";
}
function latest() {
 const log = $("log");
 $("latest").hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}
function controls() {
 const status = state.statuses?.[state.agent];
 const options = state.options || {};
 $("model").textContent = options.model || "Model: Default";
 $("effort").textContent = `Thinking: ${options.effort || "Default"}`;
 $("fast").textContent = `Fast: ${options.fast ? "On" : "Off"}`;
 $("fast").setAttribute("aria-pressed", String(!!options.fast));
 for (const id of ["model", "effort", "fast"]) $(id).disabled = state.busy || pending;
 $("workspace").textContent = state.workspace || "Your workspace";
 document.querySelectorAll(".pick button").forEach(b => {
  b.classList.toggle("on", b.dataset.a === state.agent);
  b.setAttribute("aria-pressed", String(b.dataset.a === state.agent)); b.disabled = state.busy || pending;
 });
 $("stop").hidden = !state.busy; $("go").hidden = state.busy;
 $("go").disabled = !$("in").value.trim() || state.busy || pending || !state.workspace || !state.trusted;
 $("in").placeholder = `Message ${state.names[state.agent]}…`;
 $("agent-status").hidden = !state.workspace || state.busy || (!!state.trusted && (!status || status.authenticated));
 $("refresh").hidden = !state.workspace;
 $("status").textContent = !state.workspace ? "" : !state.trusted ? "Restricted Mode" : state.busy ? `${state.names[state.agent]} is working…` : status?.label || "Checking agent…";
 $("signin").hidden = !state.workspace || !status || status.authenticated || state.busy || !state.trusted;
 $("signin").textContent = status?.installed ? "Sign in" : "Install agent";
 $("attach").disabled = state.busy || pending;
 $("new").disabled = pending; $("history").disabled = state.busy || pending;
 const attachment = $("attachment"); attachment.hidden = !state.attachment;
 attachment.replaceChildren();
 if (state.attachment) {
  const label = document.createElement("span"); label.textContent = state.attachment; label.title = state.attachment;
  const remove = document.createElement("button"); remove.textContent = "×"; remove.setAttribute("aria-label", "Remove attachment");
  remove.onclick = () => vs.postMessage({ type: "removeAttachment" }); attachment.append(label, remove);
 }
 resizeInput(); latest();
}
function render() {
 const log = $("log"), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
 log.classList.toggle("welcome", !state.busy && !state.entries.some(e => e.kind === "user" || e.kind === "assistant"));
 const signature = JSON.stringify([state.entries, state.busy, state.busy ? state.agent : null, state.workspace]);
 if (signature !== transcript) {
  transcript = signature;
  const rows = state.entries.map((e, i) => {
   const copy = `<div class="message-actions"><button class="text-button" data-copy-message="${i}">Copy message</button></div>`;
   if (e.kind === "user") return `<article class="m user" aria-label="You"><div class="b">${md(e.text)}</div>${e.context ? `<details class="message-context" data-card="context-${i}"${opened.has(`context-${i}`) ? " open" : ""}><summary>${esc(e.context.label)}</summary><pre class="context-code">${esc(e.context.text)}</pre></details>` : ""}${copy}</article>`;
   if (e.kind === "assistant") {
    const time = Number.isFinite(e.at) ? new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return `<article class="m ai" aria-label="${esc(state.names[e.agent] || "Assistant")}"><div class="who">${marks[e.agent] ? `<img class="${e.agent === "gpt" ? "openai-mark" : ""}" src="${esc(marks[e.agent])}" alt="">` : ""}${esc(state.names[e.agent] || "Assistant")}<time>${esc(time)}</time></div><div class="b${e.open ? " cur" : ""}">${md(e.text)}</div>${copy}</article>`;
   }
   if (e.kind === "tool") return `<details class="tool${e.error ? " err" : ""}" data-card="tool-${i}"${opened.has(`tool-${i}`) ? " open" : ""}><summary><span class="n">${esc(({ command: "Terminal", patch: "Changes" })[e.name] || e.name || "Tool")}</span><span class="tool-preview">${esc(e.text)}</span></summary><pre>${esc((e.detail || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))}</pre></details>`;
   return `<div class="sys">${esc(e.text)}</div>`;
  });
  const last = state.entries.at(-1);
  if (state.busy && !(last?.kind === "assistant" && last.open)) rows.push(`<div class="thinking" role="status"><i></i><i></i><i></i><span>${esc(state.names[state.agent])} is working…</span></div>`);
  if (!state.entries.some(e => e.kind === "user" || e.kind === "assistant") && !state.busy) rows.unshift(`<section class="empty"><h1>What are we building?</h1><p class="powered-by">Powered by Codex and Claude</p>${state.workspace ? `<div class="suggestions"><button class="suggestion" data-prompt="understand"><span aria-hidden="true">⌘</span>Explore this project<span aria-hidden="true">↗</span></button><button class="suggestion" data-prompt="fix"><span aria-hidden="true">⌁</span>Track down a bug<span aria-hidden="true">↗</span></button><button class="suggestion" data-prompt="plan"><span aria-hidden="true">+</span>Plan a new feature<span aria-hidden="true">↗</span></button></div>` : `<button class="open-folder" data-open-folder>Open a project</button>`}</section>`);
  log.innerHTML = rows.join("");
  log.querySelectorAll("details[data-card]").forEach(d => d.addEventListener("toggle", () => { if (!d.isConnected) return; if (d.open) opened.add(d.dataset.card); else opened.delete(d.dataset.card); }));
  log.querySelectorAll(".b pre").forEach(pre => { const button = document.createElement("button"); button.className = "text-button copy-code"; button.textContent = "Copy code"; pre.append(button); });
  if (stick) log.scrollTop = log.scrollHeight;
 }
 controls();
}
function send() {
 const text = $("in").value.trim();
 if (!text || $("go").disabled) return;
 pending = true; submitted = $("in").value; controls();
 vs.postMessage({ type: "send", text });
}
window.addEventListener("message", e => {
 const m = e.data;
 if (m?.type === "state") {
  const previousId = initialized ? state.conversationId : remembered.conversationId;
  if (previousId && previousId !== m.conversationId) { $("in").value = ""; opened.clear(); transcript = ""; $("log").scrollTop = 0; }
  state = m; initialized = true; keepDraft(); render();
 } else if (m?.type === "sendResult") {
  if (m.accepted && $("in").value === submitted) $("in").value = "";
  pending = false; keepDraft(); controls(); $("in").focus();
 }
});
$("in").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } });
$("in").addEventListener("input", () => { keepDraft(); controls(); });
$("go").onclick = send;
for (const [id, type] of Object.entries({ stop: "stop", new: "new", history: "history", attach: "attach", refresh: "refresh", signin: "signin" })) $(id).onclick = () => vs.postMessage({ type });
$("latest").onclick = () => { $("log").scrollTop = $("log").scrollHeight; latest(); };
$("log").addEventListener("scroll", latest, { passive: true });
$("log").addEventListener("click", e => {
 const button = e.target.closest("button"); if (!button) return;
 if (button.dataset.prompt) { $("in").value = prompts[button.dataset.prompt]; keepDraft(); controls(); $("in").focus(); }
 else if (button.hasAttribute("data-open-folder")) vs.postMessage({ type: "openFolder" });
 else if (button.hasAttribute("data-copy-message") || button.classList.contains("copy-code")) {
  const text = button.classList.contains("copy-code") ? button.closest("pre").querySelector("code").textContent : state.entries[Number(button.dataset.copyMessage)].text;
  vs.postMessage({ type: "copy", text }); const label = button.textContent; button.textContent = "Copied"; setTimeout(() => { button.textContent = label; }, 1200);
 }
});
document.querySelectorAll(".pick button").forEach(b => b.onclick = () => vs.postMessage({ type: "use", agent: b.dataset.a }));
new ResizeObserver(() => { resizeInput(); latest(); }).observe(document.querySelector("footer"));
vs.postMessage({ type: "ready" });

for (const field of ["model", "effort", "fast"]) $(field).onclick = () => vs.postMessage({ type: "option", field });
