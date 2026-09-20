import assert from 'node:assert/strict';
import { parseMacStudioProcesses, macStudiosWithTitles } from '../src/studioDiscovery.ts';
const processes = `
  12 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio
  13 /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
  14 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioInstaller.app/Contents/MacOS/RobloxStudioInstaller
  15 /Applications/RobloxStudio.app/Contents/MacOS/RobloxCrashHandler
  16 /Users/Some User/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio
  17 /Applications/Roblox.app/Contents/MacOS/RobloxPlayer
`;
const studios = parseMacStudioProcesses(processes);
assert.deepEqual(studios.map(s => s.name), ['Roblox Studio (12)', 'Roblox Studio (16)']);
assert.ok(studios.every(s => !s.placeId && !s.id), 'process IDs must never masquerade as MCP or place IDs');
assert.deepEqual(parseMacStudioProcesses(''), []);
console.log('Studio discovery: Mac processes, multiple installs and helper exclusions passed');

const windows = [
 { pid: 12, layer: 0, title: '[RELEASE] My Game - Config - Roblox Studio' },
 { pid: 12, layer: 0, title: '[RELEASE] My Game - Config - Roblox Studio' },
 { pid: 12, layer: 0, title: 'Roblox Studio' },
 { pid: 12, layer: 3, title: 'Panel - Roblox Studio' },
 { pid: 99, layer: 0, title: 'Closed - Roblox Studio' },
 { pid: 16, layer: 0, title: '* Local.rbxl - Roblox Studio' },
];
assert.deepEqual(macStudiosWithTitles(studios, windows).map(s => s.name), ['[RELEASE] My Game - Config', 'Local.rbxl']);
assert.deepEqual(macStudiosWithTitles(studios, []), studios);
assert.deepEqual(macStudiosWithTitles(studios, null), studios);
console.log('Studio titles: current PIDs, document names, deduplication and missing-title fallback passed');
