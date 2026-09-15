---
name: parlay-match-assets
description: From a screenshot of the game, find six Creator Store assets that fit its look and line them up in the open Roblox Studio for the owner to pick; the owner chooses, never the model
disable-model-invocation: true
arguments: [screenshot, brief]
allowed-tools: Read Glob mcp__Roblox_Studio__list_roblox_studios mcp__Roblox_Studio__screen_capture mcp__Roblox_Studio__search_asset mcp__Roblox_Studio__insert_asset mcp__Roblox_Studio__execute_luau mcp__Roblox_Studio__inspect_instance mcp__Roblox_Studio__search_game_tree mcp__chronicle__search_assets
---
Preflight, in order; stop at the first failure and say which one:
1. `list_roblox_studios` returns at least one Studio. If none, stop: "No Studio is connected. In Studio: Plugins, then the MCP toggle."
2. `$0` is a path to a PNG or JPG, or the word `capture`. For `capture`, take one `screen_capture` of the viewport as it is. For a path, Read the image.
3. `$1`, if given, is the owner's brief in their words (what the asset is for: "a wolf for the cabin", "gas pump"). If absent, ask nothing; infer the most obviously missing prop from the frame and say which one you chose.

Rules, always:
- The owner's taste rules, not yours. You are producing a lineup to click, not a decision. Never delete or move anything that is already in the place.
- Read the frame for style before you search: palette (warm or cool, saturated or muted), era, material language (stylised low-poly, textured realistic, blocky), lighting mood, scale of existing props. Write those as five words. Every query you run must carry two of them.
- Prefer real assets over part-built ones: models with MeshParts, textured, from creators with several assets. Skip anything that is a plain block rig, a billboard, or a single Part.
- Six candidates, distinct silhouettes, all roughly the scale of the thing they would replace or join.

Do:
1. Describe the style in five words and name the target prop.
2. Run three `search_asset` queries against `creator_store` (Model), each with different wording and facets, `maxResults` 8. If a Chronicle catalog is available, one `mcp__chronicle__search_assets` query too.
3. Pick six by thumbnail and metadata: silhouette fit, material language, scale. Drop near-duplicates.
4. Insert them with `insert_asset` into a Folder named `ParlayLineup` in Workspace. Then one `execute_luau` that lines them up: a row in front of the current camera, spacing = the widest bounding box plus 4 studs, feet on the ground (raycast down from each), each facing the camera, and a `BillboardGui` above each with its number 1 to 6 and the creator's name.
5. Move the camera to frame the whole row from the owner's eye height and take one `screen_capture`.
6. End with the numbered list: number, asset name, creator, asset id, one line on why it fits, and the exact words: "Pick a number, or say none. I will delete the rest of ParlayLineup and place the pick where the target prop belongs."

Output contract: the only change to the place is the new `Workspace.ParlayLineup` folder and the camera. No scripts are written. If the owner later says a number, keep that one, delete the folder's other children, move the pick to the target spot, and remove the BillboardGui.
