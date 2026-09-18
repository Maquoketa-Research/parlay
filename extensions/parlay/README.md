# Parlay

Roblox game development with Claude in the editor: see the code, see the code Claude writes, right-click
to act on a selection, and keep Aqua, Sonar and the terminal on the right. Three looks, one setting:
**Parlay Dark** (default), **Parlay Paper**, **Parlay Glass**.

This repo is a VS Code extension plus the fork configuration under `fork/`. The extension runs in plain
VS Code today; the fork (`fork/README.md`) turns it into the standalone **Parlay** app.

## What it does

- **Right-click, then Claude** on any Luau: Explain this, Ask about the selection, Fix this, Add server-side
  validation, Wrap DataStore calls in pcall, Extract to ModuleScript, Write a test, Make an A/B variant.
  The same menu sits on the editor title, and a lens appears over any multi-line selection (Explain, Fix,
  Validate, Ask). Each is a Claude Code skill (`skills/parlay-*/SKILL.md`) run in a terminal named Claude,
  on the file and line range you selected. The code lands in the file; with Script Sync on, it lands in Studio.
- **Parlay sidebar** on the right (the secondary side bar, its own container, open by default, no hide button):
  - **Aqua** (`parlay.aquaUrl`): the issues Aqua holds against this folder's game, one click from the script
    and line, with the evidence (message, stack, reports, verdict, Aqua's patch) underneath and the actions
    Apply fix, Fix with Claude, Open in Aqua, Dismiss (`docs/aqua.md`). Pairing a Studio place stays a button;
    when a local server is down the panel shows a Start button that runs `uv run aqua serve --worker` from
    `parlay.aquaRepo` (or a sibling folder named aqua) and waits for it.
  - **Meshy**, as a workflow. Describe a prop ("an axe"). Screenshots of the game set the style: everything in
    `assets/reference/` plus one live Studio capture through Roblox's Studio MCP when nothing else holds it.
    An OpenAI image model (`parlay.imageModel`, gpt-image-2.5) drafts three concepts in that look; pick one.
    Meshy turns it into a mesh only, remeshed to `parlay.meshyPolycount` triangles (20k, the Roblox cap), no
    Meshy texture. The mesh spins in a viewport in the panel; approve the shape. The viewport renders it from six
    fixed angles onto one sheet, the image model paints the sheet in the game's look (concept and screenshots as
    references), and the paint is projected back onto the mesh's UVs as a 2048 texture, weighted by how squarely
    each view sees a texel and depth-tested so hidden surfaces take nothing. Approve the textured model (or
    Repaint) and it uploads to Roblox through the Open Cloud Assets API under `parlay.robloxCreatorId`; the
    `parlay-insert-asset` skill places it in the open Studio. Files land in `assets/meshy/<slug>/`: `mesh.glb`,
    `views.png`, `paint.png`, `texture.png`, `model.glb`. Keys: **Parlay: Set OpenAI API key** (or
    `OPENAI_API_KEY`), **Set Meshy API key**, **Set Roblox Open Cloud API key**; SecretStorage, never settings
    files. Or **Parlay: Sign in to Roblox** (OAuth 2.0 with PKCE, the account shows in the Accounts menu; needs
    `parlay.robloxClientId` from an OAuth app registered with redirect URLs `http://localhost:53682/callback` and
    `http://localhost:53683/callback`). three.js renders the viewport and the bake (vendored into `media/three` at compile time).
  - **Sonar**: the market instrument (`parlay.sonarUrl`).
- **Header**: the mark, "Parlay" and the file on the first row, the menu bar on the second
  (`parlay.stackedHeader`; a fork patch adds the height, the stylesheet lays it out).
- **Match assets to a Studio screenshot** (command): the `parlay-match-assets` skill finds six Creator Store
  candidates that fit the frame's look and lines them up in Studio for you to pick.
- **Script Sync light** in the status bar: on when Studio syncs the open folder.
- **Script Sync folders just work with the tooling**: the extension writes `sourcemap.json` from the folder
  shape so luau-lsp resolves `require(ReplicatedStorage.Modules.X)`, and `selene.toml` with the Roblox
  standard so Selene reads Luau. Non-script instances (RemoteEvents, parts) come from luau-lsp's Studio
  companion plugin when you install it; the notification it shows is the one-click for that.
- **Themes**: Parlay Dark (default), Parlay Glass (real acrylic in the Parlay build; the extension flips
  `parlay.glass` when you pick it), Parlay Paper, Parlay Aqua. Generated from one palette each by
  `tools/themes.py`. The editor is always opaque.
- **The look**: activity bar at the bottom of the sidebar, menu folded into a hamburger, custom menus, no
  command center or minimap. The fork adds `fork/parlay.css`: rounded surfaces, thin edges, pill tabs and
  buttons. Bundled tooling in the fork: luau-lsp, StyLua, Selene.

## Run it

```
npm install
npm run compile && npm run check
npm run package            # parlay-ide-0.0.1.vsix
code --install-extension parlay-ide-0.0.1.vsix
```

Open a Script Sync folder (or `aqua/fixtures/sample_game`), select some lines, right-click, Claude.
`bash tools/baketest/run.sh` checks the Meshy paint bake headless in Edge (torus knot, tinted views, front reads red).
First use copies the skills to `~/.claude/skills/`; **Parlay: Install Claude skills** re-copies them.

## Layout

| Path | What |
| --- | --- |
| `src/extension.ts` | commands, the Claude terminal, the Aqua and Sonar webviews, the Script Sync status |
| `src/meshy.ts` | the Meshy workflow: drafts, mesh, viewport, paint and bake, upload |
| `skills/` | the seven skills, one folder each |
| `themes/` and `tools/themes.py` | the three looks and their generator |
| `tools/check.mjs` | manifest, source, skills and themes agree |
| `fork/` | `product.json` for the branded build and the plan |
