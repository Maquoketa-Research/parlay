# Drydock IDE

Roblox game development with Claude in the editor: see the code, see the code Claude writes, right-click
to act on a selection, and keep Aqua, Sonar and the terminal on the right. Three looks, one setting:
**Drydock Dark** (default), **Drydock Paper**, **Drydock Glass**.

This repo is a VS Code extension plus the fork configuration under `fork/`. The extension runs in plain
VS Code today; the fork (`fork/README.md`) turns it into the standalone **M | Drydock IDE** app.

## What it does

- **Right-click, then Claude** on any Luau: Explain this, Ask about the selection, Fix this, Add server-side
  validation, Wrap DataStore calls in pcall, Extract to ModuleScript, Write a test, Make an A/B variant.
  Each is a Claude Code skill (`skills/drydock-*/SKILL.md`) run in a terminal named Claude, on the file and
  line range you selected. The code lands in the file; with Script Sync on, it lands in Studio.
- **Drydock panel** on the right, beside Terminal: **Aqua** (patch queue, `drydock.aquaUrl`) and **Sonar**
  (`drydock.sonarUrl`).
- **Script Sync light** in the status bar: on when Studio syncs the open folder.
- **Themes**: generated from one palette each by `tools/themes.py`. The editor is always opaque.

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
