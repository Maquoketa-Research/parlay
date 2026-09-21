// Helpers shared by the runner (play.mjs), the Jev policy (policy-jev.mjs) and the bench, so that what Jev is
// offered, what the facts count and what the report records all agree on one definition (docs/jev-research.md
// 3.1-3.4). Pure functions, no I/O, no state.

// Sibling buttons behind one handler (Tier1.Hit, Tier2.Hit, ... all reading "Hit") fold into one group: the path
// with digits replaced plus the text. Grouping changes what Jev is offered, never how many clicks a run makes.
export const groupKey = (b) => String(b?.path ?? "").replace(/\d+/g, "#") + "|" + (b?.text ?? "");

// The one per-agent button filter (3.3), applied once in the runner right after the client probe so the facts,
// the delta, the stuck signature and the options all see the same list. A button that cannot take a click
// (Interactable=false, inherited from an ancestor) is dropped unless the agent asks for disabled buttons (the
// breaker buys with nothing); a button whose centre lies outside a clipping ancestor or the viewport is dropped
// for everyone (the click would land on something else). A probe that does not report the fields keeps the button.
export function filterButtons(buttons, offers = {}) {
	const drop = (b) => (b.interactable === false && !offers?.disabled) || b.inWindow === false;
	const kept = [], dropped = [];
	for (const b of buttons ?? []) (drop(b) ? dropped : kept).push(b);
	return { kept, dropped };
}

// the same error at another line, id, count or GUID folds into one group; also what "a new console line" means
export function fingerprint(line) {
	return line.trim().replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#").replace(/\d+/g, "#").replace(/\s+/g, " ");
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// The exploit gate (3.4): code decides "a stat changed without cause", Jev's noul is only recorded. One entry per
// stat, the first rule that holds:
//   (a) the stat went negative;
//   (b) the last action used a target with at least one prior use, and this use gave more than the larger of 10 and
//       3x the median of what its prior uses gave (a prior loss counts as 0, so a buy that suddenly grants fires;
//       the floor keeps a use that gave nothing, a walk that gave up short of the prompt or a menu click, from
//       turning the next legit +1 or +10 into a finding);
//   (c) the last action was a walk (or jump/edge) and the signed gain exceeds the larger of 10 and the drift D seen
//       over the two most recent walk steps (10 absorbs health regen and small passive income before D is known;
//       a drop, a death or a hunger tick gained nothing, and is looksWrong's territory, not the gate's).
// Input: { stats: [{ name, before, after }], lastAction: { kind, path, times }, usesBefore: { [path]: [perUse, ...] }
// (prior per-use gains of this stat by target; also accepted keyed by stat name underneath the path), walkGains:
// [|gain|, ...] (this stat over the two latest walk steps; also accepted keyed by stat name) }. Call it once per stat.
export function exploitGate({ stats = [], lastAction, usesBefore = {}, walkGains = [] } = {}) {
	const kind = lastAction?.kind, target = lastAction?.path, times = lastAction?.times ?? 1;
	const used = (kind === "click" || kind === "interact") && !!target;
	const walked = kind === "walk" || kind === "jump" || kind === "edge";
	const out = [];
	for (const { name, before, after } of stats) {
		if (typeof before !== "number" || typeof after !== "number") continue;
		const gain = after - before, perUse = gain / times;
		const hit = { stat: name, before, after, gain, perUse, target: used ? target : undefined };
		if (after < 0) { out.push({ ...hit, rule: "a" }); continue; }
		if (used) {
			const prior = Array.isArray(usesBefore[target]) ? usesBefore[target] : usesBefore[target]?.[name] ?? [];
			if (prior.length) {
				const g = median(prior);
				if (perUse > Math.max(3 * Math.max(g, 0), 10)) out.push({ ...hit, rule: "b", prior: g });
				continue;   // a used target is judged by its own history, never by walk drift
			}
		}
		if (walked) {
			const gains = Array.isArray(walkGains) ? walkGains : walkGains?.[name] ?? [];
			const D = Math.max(0, ...gains.filter((x) => typeof x === "number"));
			if (gain > Math.max(D, 10)) out.push({ ...hit, rule: "c", drift: D });
		}
	}
	return out;
}
