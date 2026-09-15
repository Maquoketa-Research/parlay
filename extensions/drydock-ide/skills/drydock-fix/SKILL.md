---
name: drydock-fix
description: Fix the defect inside a selected range of Roblox Luau with the smallest correct edit
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

Do: find the mechanism of the defect in the range. Confirm it explains the symptom before editing. Make the smallest edit that fixes the cause, inside this file only. Prefer Edit over rewriting. If the code is already correct or the defect is not in this range, say so and change nothing; a run that changes nothing is a valid outcome.

Output contract: only `<path>` from `$0` may change. No new files.
