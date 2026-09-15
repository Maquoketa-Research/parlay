# Drydock IDE

Roblox game development with Claude in the editor: see the code, see the code Claude writes, right-click
to act on a selection, and keep Aqua, Sonar and the terminal on the right. Three looks, one setting:
**Drydock Dark** (default), **Drydock Paper**, **Drydock Glass**.

This repo is a VS Code extension plus the fork configuration under `fork/`. The extension runs in plain
VS Code today; the fork (`fork/README.md`) turns it into the standalone **M | Drydock IDE** app.

## What it does

- **Right-click, then Claude** on any Luau: Explain this, Ask about the selection, Fix this, Add server-side
  validation, Wrap DataStore calls in pcall, Extract to ModuleScript, Write a test, Make an A/B variant.
  The same menu sits on the editor title, and a lens appears over any multi-line selection (Explain, Fix,
  Validate, Ask). Each is a Claude Code skill (`skills/drydock-*/SKILL.md`) run in a terminal named Claude,
  on the file and line range you selected. The code lands in the file; with Script Sync on, it lands in Studio.
- **Drydock panel** on the right, beside Terminal:
  - **Aqua**: the patch queue (`drydock.aquaUrl`). When the server is down the view shows a Start button that
    runs `uv run aqua serve --worker` from `drydock.aquaRepo` (or a sibling folder named aqua) and waits for it.
  - **Meshy**: a prompt or a reference image goes to Meshy (text-to-3D preview, then Refine for textures, or
    image-to-3D), the model lands in `assets/meshy/`, **Upload to Roblox** sends it through the Open Cloud
    Assets API as a Model under `drydock.robloxCreatorId`, and **Insert in Studio** runs the
    `drydock-insert-asset` skill in the open Studio. Keys: **Drydock: Set Meshy API key** and **Set Roblox
    Open Cloud API key** (SecretStorage, never settings files).
  - **Sonar**: the market instrument (`drydock.sonarUrl`).
- **Match assets to a Studio screenshot** (command): the `drydock-match-assets` skill finds six Creator Store
  candidates that fit the frame's look and lines them up in Studio for you to pick.
- **Script Sync light** in the status bar: on when Studio syncs the open folder.
- **Themes**: Drydock Dark (default), Drydock Glass (real acrylic in the Drydock IDE build; the extension flips
  `drydock.glass` when you pick it), Drydock Paper, Drydock Aqua. Generated from one palette each by
  `tools/themes.py`. The editor is always opaque.
- **The look**: activity bar at the bottom of the sidebar, menu folded into a hamburger, custom menus, no
  command center or minimap. The fork adds `fork/drydock.css`: rounded surfaces, thin edges, pill tabs and
  buttons. Bundled tooling in the fork: luau-lsp, StyLua, Selene.

## Run it

```
npm install
npm run compile && npm run check
npm run package            # drydock-ide-0.0.1.vsix
code --install-extension drydock-ide-0.0.1.vsix
```

Open a Script Sync folder (or `aqua/fixtures/sample_game`), select some lines, right-click, Claude.
First use copies the skills to `~/.claude/skills/`; **Drydock: Install Claude skills** re-copies them.

## Layout

| Path | What |
| --- | --- |
| `src/extension.ts` | commands, the Claude terminal, the two webviews, the Script Sync status |
| `skills/` | the seven skills, one folder each |
| `themes/` and `tools/themes.py` | the three looks and their generator |
| `tools/check.mjs` | manifest, source, skills and themes agree |
| `fork/` | `product.json` for the branded build and the plan |
