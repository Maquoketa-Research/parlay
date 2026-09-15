---
name: parlay-test
description: Write a focused test for the function in a selected range of Roblox Luau
disable-model-invocation: true
arguments: [target]
allowed-tools: Read Grep Glob Write Bash(ls *) Bash(dir *)
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

Do: find the test runner this game uses (look for `*.spec.luau`, TestEZ, Jest-Lua, or a `tests/` folder; base-place games have a harness). Write one spec file for the function in the range, next to it or where the other specs live, covering the normal case, the boundary the code guards, and one failure. If there is no runner, still write a TestEZ-style `describe`/`it` spec and say that a runner is missing.

Output contract: one new spec file; the original file is not touched.
