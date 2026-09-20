// Match only the main application, never its installer, crash handler or MCP proxy.
export function parseMacStudioProcesses(output: string): { id: string; name: string; placeId: string; detail: string }[] {
	return output.split(/\r?\n/).flatMap(line => {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match || !/\/RobloxStudio\.app\/Contents\/MacOS\/RobloxStudio$/.test(match[2])) return [];
		return [{ id: "", name: `Roblox Studio (${match[1]})`, placeId: "", detail: "Studio is running; open a place and enable Studio MCP to detect its name and ID." }];
	});
}

// Only associate a title with a currently running Studio PID. Empty titles and the
// start screen do not identify a place, and auxiliary panels must not become projects.
export function macStudiosWithTitles(processes: ReturnType<typeof parseMacStudioProcesses>, windows: unknown): ReturnType<typeof parseMacStudioProcesses> {
	if (!Array.isArray(windows)) return processes;
	return processes.flatMap(process => {
		const pid = Number(/\((\d+)\)$/.exec(process.name)?.[1]);
		const names = new Set<string>();
		for (const window of windows) {
			if (!window || window.pid !== pid || window.layer !== 0 || typeof window.title !== "string") continue;
			const match = /^(.+?)\s+-\s+Roblox Studio$/.exec(window.title.trim());
			const name = match?.[1].replace(/^\*\s*/, "").trim();
			if (name) names.add(name);
		}
		return names.size ? [...names].map(name => ({ id: "", name, placeId: "", detail: "Open Studio document; place ID unavailable without MCP." })) : [process];
	});
}
