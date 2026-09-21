// The Quality Assurance page (src/qa.ts html()): setup, the live run, the result with its findings, previous runs.
// Everything it shows comes from the extension as messages; every click goes back as one.
(() => {
	const vs = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
	const msg = (m) => `data-msg='${esc(JSON.stringify(m))}'`;
	const shot = (src) => src ? `<img class="shot" src="${esc(src)}" alt="screenshot" title="Click to enlarge">` : "";
	const before = (b) => b.length ? `<div class="before">Before: ${esc(b.join("; "))}</div>` : "";
	const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
	const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
	const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	const ICON = {
		ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/></svg>',
		bad: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg>',
		eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="3"/></svg>',
		fail: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
	};
	const main = document.querySelector("main");
	const agentName = (id) => $("agent").querySelector(`[data-v="${id}"] b`)?.textContent ?? id;
	const ended = (by) => by === "jev" ? "the agent called it done" : by === "stopped" ? "stopped by you" : by === "cap" ? "hit the time cap" : "";

	const form = { agent: "explorer", policy: "jev" };
	let hasKey = false, running = false, timer, live = { at: 0 }, current = "";
	const counts = { steps: 0, err: 0, notes: 0, sus: 0, stuck: 0 };
	let wasStuck = false;

	const placeValue = () => $("place").value === "__id" ? $("placeId").value.trim() : $("place").value;
	function paint() {
		for (const b of $("agent").children) b.setAttribute("aria-pressed", String(b.dataset.v === form.agent));
		for (const b of $("policy").children) b.setAttribute("aria-pressed", String(b.dataset.v === form.policy));
		$("keynote").innerHTML = form.policy === "jev"
			? (hasKey ? `Jev by TypeSafe plays as the ${esc(agentName(form.agent))}, picks every move, and says when it has seen enough.` : `Jev needs a TypeSafe key. <a id="setkey">Set one</a> (typesafe.ai), or play scripted.`)
			: "A fixed script explores for five minutes: walks, clicks and interacts. Errors and stuck spots still count; no personality, nothing judges the screen.";
		$("agent").hidden = form.policy !== "jev";
		$("placeId").hidden = $("place").value !== "__id";
		$("run").disabled = running || (form.policy === "jev" && !hasKey) || !/^\d+$/.test(placeValue());
	}
	function setCounts() { $("c-steps").textContent = counts.steps; $("c-err").textContent = counts.err; $("c-notes").textContent = counts.notes; $("c-sus").textContent = counts.sus; $("c-stuck").textContent = counts.stuck; }
	function tick() { $("clock").textContent = clock((Date.now() - live.at) / 1000); }
	function status(text) { $("status").innerHTML = `<i></i><span title="${esc(text)}">${esc(text)}</span>`; }
	function start(m) {
		running = true; live = { at: m.at }; current = "";
		Object.assign(counts, { steps: 0, err: 0, notes: 0, sus: 0, stuck: 0 }); wasStuck = false;
		$("liveplace").textContent = `${m.place} · ${m.policy === "jev" ? agentName(m.agent) : "scripted"}`;
		$("donelabel").textContent = m.policy === "jev" ? "done 0%" : "";
		$("bar").style.width = "0%";
		status("Starting the runner…"); $("steps").innerHTML = ""; $("feedcount").textContent = ""; setCounts(); tick();
		$("setup").hidden = true; $("result").hidden = true; $("live").hidden = false; $("feed").hidden = false; $("stop").disabled = false;
		clearInterval(timer); timer = setInterval(tick, 1000);
		paint();
	}
	function finish() {
		running = false; clearInterval(timer);
		$("live").hidden = true; $("setup").hidden = false;
		paint();
	}

	$("agent").onclick = $("policy").onclick = (e) => {
		const b = e.target.closest("button"); if (!b) return;
		if (b.parentElement.id === "agent") form.agent = b.dataset.v; else form.policy = b.dataset.v;
		paint();
	};
	$("place").onchange = () => { paint(); if (!$("placeId").hidden) $("placeId").focus(); };
	$("placeId").oninput = paint;
	$("run").onclick = () => { if (!running) vs.postMessage({ type: "run", place: placeValue(), agent: form.agent, policy: form.policy }); };
	$("stop").onclick = () => { $("stop").disabled = true; vs.postMessage({ type: "stop" }); };
	$("refresh").onclick = () => vs.postMessage({ type: "refresh" });
	$("open").onclick = () => vs.postMessage({ type: "md" });
	document.addEventListener("click", (e) => {
		if (e.target.id === "setkey") { vs.postMessage({ type: "setKey" }); return; }
		if (e.target.matches("img.shot")) { e.target.classList.toggle("big"); return; }
		const b = e.target.closest("[data-msg]");
		if (b) vs.postMessage(JSON.parse(b.dataset.msg));
	});

	window.addEventListener("message", ({ data: m }) => {
		if (m.type === "init") {
			hasKey = m.hasKey;
			const opts = m.studios.map((s) => `<option value="${esc(s.placeId)}">${esc(s.name)}  ·  ${esc(s.placeId)}</option>`);
			$("place").innerHTML = opts.join("") + `<option value="__id">Enter a place id…</option>`;
			const remembered = m.form.place, known = m.studios.some((s) => s.placeId === remembered);
			const v = known ? remembered : m.studios[0]?.placeId || "__id";
			if (v === "__id" && remembered) $("placeId").value = remembered;
			$("place").value = v;
			$("empty").hidden = !!opts.length;
			form.agent = $("agent").querySelector(`[data-v="${m.form.agent}"]`) ? m.form.agent : "explorer";
			form.policy = m.form.policy === "scripted" || !hasKey ? "scripted" : "jev";
			if (m.live) start(m.live); else if (!m.running) finish();
			paint(); runs(m.runs);
		} else if (m.type === "started") {
			start(m);
		} else if (m.type === "out") {
			status(m.text);
		} else if (m.type === "step") {
			const newErr = m.errorGroups > counts.err;
			counts.steps = m.step; counts.err = m.errorGroups; counts.notes += m.notes.length; if (m.suspect) counts.sus++; if (m.stuck && !wasStuck) counts.stuck++; wasStuck = !!m.stuck; setCounts();
			if (m.done !== undefined) { $("donelabel").textContent = `done ${Math.round(m.done * 100)}%`; $("bar").style.width = `${Math.round(m.done * 100)}%`; }
			const tags = [newErr ? `<span class="tag red">new error</span>` : "", m.stuck ? `<span class="tag amber">stuck</span>` : "", m.suspect ? `<span class="tag purple">suspect</span>` : "",
				...m.notes.map((k) => `<span class="tag blue">${esc(k)}</span>`), m.jev !== undefined ? `<span class="tag">looks wrong ${Math.round(m.jev * 100)}%</span>` : ""].join("");
			const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
			const d = document.createElement("div");
			d.className = "step";
			d.innerHTML = `<div class="n">${m.step}</div><div class="a">${esc(m.action)} <span>→ ${esc(m.outcome)}${m.newLines.length ? ` · +${plural(m.newLines.length, "line")}` : ""}</span></div>`
				+ (tags ? `<div class="tags">${tags}</div>` : "") + (m.newLines.length ? `<pre>${esc(m.newLines.join("\n"))}</pre>` : "") + shot(m.screenshot);
			$("steps").appendChild(d);
			$("feedcount").textContent = `(${m.step})`;
			if (nearBottom) main.scrollTop = main.scrollHeight;
		} else if (m.type === "done") {
			if (m.final) finish();
			current = m.name;
			result(m); runs(m.runs);
			if (!m.final) $("result").scrollIntoView({ block: "start" });
		}
	});

	function result(m) {
		const r = m.report, f = m.findings || { errors: [], suspects: [], stuck: [], notes: [] };
		const errs = f.errors.length, sus = f.suspects.length, stuck = f.stuck.length, notes = f.notes.length;
		const who = r?.policy === "jev" ? agentName(r.agent) : "the script";
		const [cls, icon, head, sub] = m.failure ? ["amber", ICON.fail, "The runner failed", m.failure]
			: !r ? ["amber", ICON.fail, `Exit ${m.code ?? "?"}`, "No report was written."]
			: errs ? ["red", ICON.bad, `${plural(errs, "error group")} in ${r.place}`, "Script errors a player would hit. Open each in the editor or hand it to Claude."]
			: notes ? ["blue", ICON.eye, `${who} noted ${plural(notes, "thing")} in ${r.place}`, "No script errors; these are what the agent flagged. Check each with its screenshot."]
			: sus ? ["purple", ICON.eye, `Nothing crashed, ${plural(sus, "suspect")}`, "No script errors, but Jev thought these moments looked wrong. Check the screenshots."]
			: stuck ? ["amber", ICON.fail, "Nothing crashed, but the player got stuck", "Same spot and a silent console for five steps: walls, pits, dead ends."]
			: ["green", ICON.ok, `Clean run in ${r.place}`, `${who} found no errors, nothing suspect, and never got stuck.`];
		$("verdict").className = `verdict ${cls}`;
		$("verdict").innerHTML = `${icon}<div><b>${esc(head)}</b><span>${esc(sub)}</span></div>`;
		$("rcounts").innerHTML = r ? [`<span class="chip">${plural(r.steps, "step")}</span>`, `<span class="chip">${clock(r.duration)}</span>`, `<span class="chip">${esc(who)}</span>`, ended(r.doneBy) ? `<span class="chip">${esc(ended(r.doneBy))}</span>` : "",
			`<span class="chip${r.aqua === "ok" ? " green" : ""}" title="${esc(r.aqua ?? "")}">${r.aqua === "ok" ? "sent to Aqua" : r.aqua ? "Aqua: " + esc(r.aqua) : "not sent to Aqua"}</span>`].join("") : "";
		$("findings").innerHTML = [
			...f.errors.map((e, i) => `<div class="finding"><div class="t">${e.count > 1 ? `${e.count}× ` : ""}${esc(e.message)}</div><div class="m">${esc(e.side)} · steps ${esc(e.steps)}</div>`
				+ (e.trace.length ? `<details><summary>Stack</summary><pre>${esc(e.trace.join("\n"))}</pre></details>` : "") + before(e.before) + shot(e.screenshot)
				+ `<div class="actions">${e.loc ? `<button class="btn" ${msg({ type: "goto", i })}>Open in editor</button><button class="btn alt" ${msg({ type: "fix", i })}>Fix with Claude</button>` : `<span class="m">Names no script and line.</span>`}</div></div>`),
			...f.notes.map((n) => `<div class="finding blue"><div class="t">${esc(n.kind)}: ${esc(n.text)}</div><div class="m">step ${n.step} · Jev ${n.percent}%</div>`
				+ (n.console.length ? `<details><summary>Console</summary><pre>${esc(n.console.join("\n"))}</pre></details>` : "") + before(n.before) + shot(n.screenshot) + `</div>`),
			...f.suspects.map((s) => `<div class="finding purple"><div class="t">Looked wrong to Jev (${s.percent}%) at step ${s.step}</div>`
				+ (s.console.length ? `<details><summary>Console</summary><pre>${esc(s.console.join("\n"))}</pre></details>` : "") + before(s.before) + shot(s.screenshot) + `</div>`),
			...f.stuck.map((s) => `<div class="finding amber"><div class="t">Player stuck</div><div class="m">${esc(s)}</div></div>`),
		].join("");
		$("md").innerHTML = m.md;
		$("result").hidden = false;
	}

	function runs(list) {
		$("runs").innerHTML = list.length ? list.map((r) => {
			const dot = r.exit === 1 ? "gray" : r.errors ? "red" : r.notes || r.suspects || r.stuck ? "amber" : "green";
			const c = r.exit === 1 ? "failed" : [r.errors && `${r.errors} err`, r.notes && `${r.notes} note${r.notes === 1 ? "" : "s"}`, r.suspects && `${r.suspects} sus`, r.stuck && `${r.stuck} stuck`].filter(Boolean).join(" · ") || "clean";
			return `<button class="run${r.name === current ? " on" : ""}" ${msg({ type: "show", name: r.name })}><i class="dot ${dot}"></i><div class="d"><b>${esc(r.place)}</b><span>${esc(when(r.start))} · ${esc(r.policy === "jev" ? agentName(r.agent) : "scripted")} · ${plural(r.steps, "step")}</span></div><span class="c">${esc(c)}</span></button>`;
		}).join("") : `<div class="hint">${ICON.eye}<span>Runs land here with their findings and screenshots.</span></div>`;
	}
})();
