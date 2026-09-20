// Project associations take precedence over an unrelated Studio window.
export interface ProjectIdentity { placeId?: string; universeId?: string; name?: string; studioUserId?: string }
export const robloxId = (value: unknown): string | undefined => typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
export function chooseProjectIdentity(mapped: ProjectIdentity[], cached?: ProjectIdentity): ProjectIdentity | undefined {
	const candidates = mapped.filter(p => robloxId(p.placeId));
	const distinct = [...new Set(candidates.map(p => p.placeId))];
	if (distinct.length > 1) return undefined;
	if (distinct.length === 1) return candidates.find(p => p.placeId === distinct[0]);
	return robloxId(cached?.placeId) ? cached : undefined;
}
