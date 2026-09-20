// Jev as the play policy: the same decide(state, history) → action contract as policy.mjs, answered by
// TypeSafe's HTTP API over fetch (no SDK). Stub: another change fills it in. Until then it defers to the
// scripted policy so PARLAY_QA_POLICY=jev already runs end to end.
import scripted from "./policy.mjs";

export async function decide(state, history) {
	// TODO(jev): POST { state, history: history.slice(-20) } to TypeSafe, validate the reply against the action
	// shapes in policy.mjs, fall back to scripted() on a bad or slow answer
	return scripted(state, history);
}

export default decide;
