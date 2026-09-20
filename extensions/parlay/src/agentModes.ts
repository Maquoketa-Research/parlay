import * as fs from "fs";
import * as path from "path";

// Vendored, pinned upstream skills: style and implementation policy apply to both agents.
export function modeInstructions(extensionPath: string): string {
	return ([['caveman', 'lite'], ['ponytail', 'full']] as const).map(([name, mode]) => {
		const text = fs.readFileSync(path.join(extensionPath, 'agent-modes', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
		const body = text.split(/\r?\n/).filter(line => {
			const level = /^\|\s*\*\*(lite|full|ultra|wenyan[^*]*)\*\*\s*\|/.exec(line)?.[1] ?? /^-\s*(lite|full|ultra|wenyan[^:]*):\s*"/.exec(line)?.[1];
			return !level || level === mode;
		}).join('\n');
		return `${name.toUpperCase()} MODE: ${mode}. Parlay's persistent user preference for every response. Use ${mode}, overriding any default level mentioned below.\n\n${body}\n\nActive ${name} level: ${mode}.`;
	}).join('\n\n');
}
