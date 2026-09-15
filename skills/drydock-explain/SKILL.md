---
name: drydock-explain
description: Explain a selected range of Luau in a Roblox game, with the Roblox-specific hazards; makes no edits
disable-model-invocation: true
arguments: [target, question]
allowed-tools: Read Grep Glob
---
Preflight, in order; stop at the first failure and say which one:
1. `$0` has the form `<path>:<start>-<end>`. Read that file. If the range is outside the file, stop.
2. The file is Luau (`.luau` or `.lua`). If not, stop.
3. Read enough surrounding code to understand the range: the enclosing function, its callers in this file, and any module it requires.

Rules, always:
- This is Roblox. Server code is authoritative; never trust client-supplied values; RemoteEvent handlers validate every argument. DataStore calls go in pcall.
- Match the file's conventions: naming, indentation, `--!strict` if present, comment density.
- Do not refactor, rename, reformat, or fix anything outside what this skill asks for.
- File names follow Script Sync: `.server.luau` is a Script, `.client.luau` a LocalScript, `.luau` a ModuleScript.
- Finish with two plain sentences: what changed, and why it is correct. No headings, no lists.

Do: explain the range in at most six sentences. Say what it does, what it assumes, and the Roblox hazards that apply (client trust, replication, DataStore limits, race conditions, memory leaks from connections). If `$1` is a question, answer that question about the range instead. Make no edits.
