---
name: parlay-extract
description: Extract a selected range of Roblox Luau into a ModuleScript and require it from the original
disable-model-invocation: true
arguments: [target]
allowed-tools: Read Grep Glob Edit Write
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

Do: move the range into a new ModuleScript that returns a table. Place it under `ReplicatedStorage/Modules/` if both client and server can use it, or `ServerStorage/Modules/` if it touches server-only services (DataStore, ServerStorage, MarketplaceService receipts). Name it after what it does, PascalCase, `.luau`. Replace the range in the original with a `require` and a call. Keep behaviour identical; the diff to the original should be the removed lines plus the require.

Output contract: exactly two files change: `<path>` from `$0`, and the one new module. Say the new module's path.
