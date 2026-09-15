---
name: drydock-pcall
description: Wrap DataStore calls in a selected range in pcall with retry and honest failure handling
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

Do: every `GetAsync`, `SetAsync`, `UpdateAsync`, `IncrementAsync`, `RemoveAsync` in the range runs inside `pcall`, retried up to 3 times with a short backoff (`task.wait`), and the failure path is explicit: log with `warn`, and return or keep the last known value; never write a default over data that failed to load. Prefer `UpdateAsync` where the existing code does read-modify-write.

Output contract: only `<path>` from `$0` may change. No new files.
