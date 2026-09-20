// The QA view's page (src/qa.ts html()): the form, the live steps, the findings with their actions, the runs.
// Everything it shows comes from the extension as messages; every click goes back as one.
(() => {
	const vs = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
	const msg = (m) => `data-msg='${esc(JSON.stringify(m))}'`;
	const shot = (src) => src ? `<img class="shot" src="${esc(src)}" alt="screenshot" title="Click to enlarge">` : "";
	const before = (b) => b.length ? `<div class="dim">Before: ${esc(b.join("; "))}</div>` : "";
	let running = false;
	const setRunning = (on) => { running = on; $("run").hidden = on; $("stop").hidden = !on; $("refresh").disabled = on; };

	$("f").onsubmit = (e) => {
		e.preventDefault();
		if (running) return;
		$("steps").innerHTML = ""; $("result").hidden = true;
		vs.postMessage({ type: "run", place: $("place").value.trim(), minutes: Number($("minutes").value), policy: $("policy").value });
	};
	$("stop").onclick = () => vs.postMessage({ type: "stop" });
	$("refresh").onclick = () => vs.postMessage({ type: "refresh" });
	$("setkey").onclick = () => vs.postMessage({ type: "setKey" });
	$("open").onclick = () => vs.postMessage({ type: "md" });
	document.addEventListener("click", (e) => {
		if (e.target.matches("img.shot")) { e.target.classList.toggle("big"); return; }
		const b = e.target.closest("[data-msg]");
		if (b) vs.postMessage(JSON.parse(b.dataset.msg));
	});

	window.addEventListener("message", ({ data: m }) => {
		if (m.type === "init") {
			$("studios").innerHTML = m.studios.map((s) => `<option value="${esc(s.placeId)}">${esc(s.name)}</option>`).join("");
			if (!$("place").value) $("place").value = m.form.place || m.studios[0]?.placeId || "";
			$("minutes").value = m.form.minutes;
			$("policy").querySelector("option[value=jev]").disabled = !m.hasKey;
			$("policy").value = m.form.policy;
			$("nokey").hidden = m.hasKey;
			if (!m.studios.length && !m.running) $("status").textContent = "No open Studio place found. Open one in Studio and ↻, or type a place id and the runner opens it.";
			setRunning(m.running);
			runs(m.runs);
		} else if (m.type === "started") {
			setRunning(true);
			$("status").textContent = `Playing ${m.place} for ${m.minutes} min with the ${m.policy} policy…`;
		} else if (m.type === "out") {
			$("status").textContent = m.text;
		} else if (m.type === "step") {
			const d = document.createElement("div");
			d.className = "step";
			d.innerHTML = `<span class="n">${m.step}</span> ${esc(m.action)} <span class="dim">→ ${esc(m.outcome)} · +${m.newLines.length} lines</span> <span class="${m.errorGroups ? "err" : "dim"}">${m.errorGroups} error${m.errorGroups === 1 ? "" : "s"}</span>`
				+ (m.stuck ? ` <span class="stuck">stuck</span>` : "") + (m.jev !== undefined ? ` <span class="dim">jev wrong ${Math.round(m.jev * 100)}%</span>` : "")
				+ (m.newLines.length ? `<pre class="mono">${esc(m.newLines.join("\n"))}</pre>` : "") + shot(m.screenshot);
			$("steps").appendChild(d);
			d.scrollIntoView({ block: "end" });
		} else if (m.type === "done") {
			setRunning(false);
			done(m);
			runs(m.runs);
		}
	});

	function done(m) {
		const r = m.report, f = m.findings;
		$("result").hidden = false;
		$("status").textContent = m.failure ? `Runner failure: ${m.failure}` : r ? `Done: exit ${m.code}. Aqua: ${r.aqua ?? "not attempted"}` : `Exit ${m.code}, no report written.`;
		$("headline").textContent = r ? `${r.place} · ${r.steps} steps · ${r.policy} · ${f.errors.length} error groups · ${f.stuck.length} stuck · ${f.suspects.length} suspects` : m.name;
		$("findings").innerHTML = !f ? "" : [
			...f.errors.map((e, i) => `<div class="finding"><b>${e.count}× ${esc(e.message)}</b><div class="dim">${esc(e.side)} · steps ${esc(e.steps)}</div>`
				+ (e.trace.length ? `<pre class="mono">${esc(e.trace.join("\n"))}</pre>` : "") + before(e.before) + shot(e.screenshot)
				+ `<div class="actions">${e.loc ? `<button ${msg({ type: "goto", i })}>Open in editor</button><button class="alt" ${msg({ type: "fix", i })}>Fix with Claude</button>` : `<span class="dim">Names no script and line.</span>`}</div></div>`),
			...f.suspects.map((s) => `<div class="finding"><b>Suspect at step ${s.step}: Jev ${s.percent}% "looks wrong"</b>` + (s.console.length ? `<pre class="mono">${esc(s.console.join("\n"))}</pre>` : "") + before(s.before) + shot(s.screenshot) + `</div>`),
			...f.stuck.map((s) => `<div class="finding"><b class="stuck">Stuck: ${esc(s)}</b></div>`),
		].join("") || `<div class="finding dim">No findings.</div>`;
		$("md").innerHTML = m.md;
	}

	function runs(list) {
		$("runs").innerHTML = list.length ? list.map((r) => `<div class="run" ${msg({ type: "show", name: r.name })}><span>${esc(r.start.slice(0, 16).replace("T", " "))}</span><span class="dim">${esc(r.place)} · ${esc(r.policy)}</span>`
			+ `<span class="c ${r.errors || r.stuck ? "err" : "dim"}">${r.exit === 1 ? "failed" : `${r.errors} err · ${r.stuck} stuck · ${r.suspects} sus`}</span></div>`).join("") : "None yet.";
	}
})();
