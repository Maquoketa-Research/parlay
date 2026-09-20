// The same requester protocol as Aqua's Studio client. Approval stays in the dashboard.
export interface PairIdentity { placeId: string; universeId: string; placeName: string; studioUserId: string }
export interface PairedPlace extends PairIdentity { game: string }
export const pairingSecret = (url: string, place: PairIdentity) => `parlay.aquaPair:${encodeURIComponent(url)}:${place.placeId}:${place.studioUserId}`;

export async function pairingCall(url: string, route: string, signal: AbortSignal, body?: unknown, key?: string) {
	const r = await fetch(url + route, {
		method: body === undefined ? "GET" : "POST",
		headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "X-Aqua-Key": key } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), redirect: "error",
	});
	const raw: unknown = await r.json().catch(() => ({}));
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Aqua returned an invalid response.");
	const data = raw as Record<string, unknown>;
	if (!r.ok) throw new Error(r.status === 404 ? "The pairing request expired or Aqua does not support this endpoint. Pair again." : String(data.detail ?? `Aqua answered HTTP ${r.status}`));
	return data;
}

export async function checkPairing(url: string, place: PairIdentity, key: string, signal: AbortSignal) {
	const data = await pairingCall(url, `/api/studio/ping?place_id=${encodeURIComponent(place.placeId)}`, signal, undefined, key);
	const info = data.place && typeof data.place === "object" ? data.place as Record<string, unknown> : undefined;
	if (info ? info.known !== true : String(data.placeId) !== place.placeId) throw new Error("This credential belongs to a different place. Pair this project again.");
	if (info?.blocked) throw new Error(String(info.blocked));
	return data;
}

export async function requestPairing(url: string, place: PairIdentity, signal: AbortSignal, onCode: (code: string) => void): Promise<{ key: string; game: string }> {
	const started = await pairingCall(url, "/api/studio/pair", signal, place);
	if (typeof started.id !== "string" || !started.id || typeof started.code !== "string" || !started.code) throw new Error("Aqua returned an invalid pairing request.");
	onCode(started.code);
	const expires = typeof started.expires_in === "number" && Number.isFinite(started.expires_in) ? Math.min(300, Math.max(0, started.expires_in)) : 300;
	const polling = AbortSignal.any([signal, AbortSignal.timeout(expires * 1000)]);
	while (true) {
		polling.throwIfAborted();
		const result = await pairingCall(url, `/api/studio/pair/${encodeURIComponent(started.id)}?wait=10`, polling);
		if (result.status === "denied") throw new Error("Pairing was declined in Aqua.");
		if (result.status === "approved") {
			if (typeof result.key !== "string" || !result.key || typeof result.game !== "string") throw new Error("Aqua approved pairing without a valid credential.");
			await checkPairing(url, place, result.key, polling);
			polling.throwIfAborted();
			return { key: result.key, game: result.game };
		}
		if (result.status !== "pending") throw new Error("The pairing request is no longer pending. Pair again.");
		// Also accommodate servers which answer pending without long-polling.
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}
}
