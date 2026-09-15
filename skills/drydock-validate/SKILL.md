---
name: drydock-validate
description: Add server-side validation to the RemoteEvent or RemoteFunction handler in a selected range
disable-model-invocation: true
arguments: [target]
allowed-tools: Read Grep Glob Edit
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

Do: for the handler in the range, validate every argument the client sends before any state changes: type checks with `typeof`, membership in known tables, numeric ranges, ownership (the player may only act on their own things), and a per-player rate limit if the action can be spammed. Reject with an early `return` (and a `warn` matching the file's style). Never move validation to the client.

Output contract: only `<path>` from `$0` may change. No new files.
