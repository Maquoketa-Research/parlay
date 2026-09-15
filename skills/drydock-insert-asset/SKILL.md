---
name: drydock-insert-asset
description: Insert a Roblox asset by id into the open Studio place, on the ground in front of the camera, and show it; used by the Meshy tab after an upload
disable-model-invocation: true
arguments: [assetId, name]
allowed-tools: mcp__Roblox_Studio__list_roblox_studios mcp__Roblox_Studio__insert_asset mcp__Roblox_Studio__execute_luau mcp__Roblox_Studio__inspect_instance mcp__Roblox_Studio__screen_capture
---
Preflight, in order; stop at the first failure and say which one:
1. `list_roblox_studios` returns at least one Studio. If none, stop: "No Studio is connected. In Studio: Plugins, then the MCP toggle."
2. `$0` is a numeric asset id. `$1` is the name to give the inserted model (optional; default the asset's own name).

Do:
1. `insert_asset` with id `$0` into a Folder named `DrydockAssets` in Workspace (create it if missing). If Studio refuses (asset not yet approved, or not owned by this account), say exactly what it said and stop.
2. One `execute_luau`: name the model `$1` if given, `PivotTo` it so it stands on the ground 12 studs in front of the current camera (raycast down from the camera's forward point to find the floor; if nothing is hit, use the SpawnLocation height), facing the camera. Anchor its parts.
3. `screen_capture` once so the owner sees it.
4. Reply in two sentences: where it landed and its size in studs from `GetExtentsSize`.

Rules: change nothing outside `Workspace.DrydockAssets`. Write no scripts. Never delete anything.
