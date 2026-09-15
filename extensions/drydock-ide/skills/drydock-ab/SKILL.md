---
name: drydock-ab
description: Make an A/B variant of the behaviour in a selected range, with a deterministic flag and one exposure event
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

Do: create or extend `ReplicatedStorage/Modules/Experiments.luau` with a function `variant(player, name): "A" | "B"` that assigns 50/50 deterministically from `player.UserId` and `name` (hash, not random) so a player always sees the same arm. Name the experiment after the range's behaviour in snake_case. In the range, branch on the variant: A is the current behaviour untouched, B is the alternative the owner asked for (if none was given, leave B as a clearly marked copy of A for the owner to edit). Fire one exposure event `<name>_exposed` with the arm through the game's existing telemetry module if there is one; otherwise `print` it and say so.

Output contract: `<path>` from `$0` and `Experiments.luau` change. Nothing else.
