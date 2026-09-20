// The play policy: what to do next, from what the probes saw and what was already done. Deliberately dumb,
// no model: an unclicked visible GUI button, else the nearest interactable not yet visited, else a random
// walk with a jump. A Jev or LLM policy replaces it by exporting the same shape (see policy-jev.mjs).
//   decide(state, history) → action
//   state:   { server: <probe.server.luau JSON>, client: <probe.client.luau JSON>, stuck: boolean }
//   history: [{ step, action, result, position }] so far, oldest first
//   action:  { kind: "click", path, text }                                        GUI button, by instance path
//          | { kind: "interact", path, class, position: [x, y, z], distance }     walk there, then E / click / touch
//          | { kind: "walk", key: "W"|"A"|"S"|"D", ms, jump: boolean }            hold a key, jump
export function decide(state, history) {
	const done = new Set(history.map((h) => h.action?.path).filter(Boolean));
	// stuck means the last five tries changed nothing; try moving instead of repeating the plan
	if (!state.stuck) {
		const button = (state.client?.buttons ?? []).find((b) => !done.has(b.path));
		if (button) return { kind: "click", path: button.path, text: button.text, x: button.x, y: button.y };
		const target = (state.server?.interactables ?? []).find((i) => !done.has(i.path));
		if (target) return { kind: "interact", path: target.path, class: target.class, position: target.position, distance: target.distance };
	}
	return { kind: "walk", key: "WASD"[Math.floor(Math.random() * 4)], ms: 800, jump: true };
}

export default decide;
