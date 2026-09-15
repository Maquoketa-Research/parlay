# Drydock IDE

A fork of [Visual Studio Code](https://github.com/microsoft/vscode) for Roblox game development with Claude in
the editor: you write the game's structure, Claude writes the hard parts. See the code, see the code Claude
writes, right-click to act on a selection, and keep Aqua, Meshy and Sonar in the right sidebar. Roblox Studio
stays the editor for the world; Drydock works on the Script Sync folder.

Three looks, one setting: **Drydock Dark** (default), **Drydock Glass** (real Windows acrylic), **Drydock Paper**.

## What is in the tree

| Path | What |
| --- | --- |
| everything else | Visual Studio Code at the upstream tag in `package.json`, with [VSCodium](https://github.com/VSCodium/vscodium)'s build patches applied (telemetry out, Open VSX as the gallery, update feed off, the app renamed) and Drydock's own changes on top: glass chrome, the two-row header, the look (`src/vs/workbench/browser/media/style.css`), `product.json`, the icons under `resources/win32` |
| `extensions/drydock-ide/` | the Drydock extension, built in like `git` or `emmet`: the Claude right-click actions and skills, the Aqua, Meshy and Sonar sidebars, the themes, the Script Sync helpers ([its README](extensions/drydock-ide/README.md)) |
| `build/drydock/` | the fork's build: `build-win32.sh` (app and installer), `fetch-builtins.sh` (luau-lsp and StyLua from Open VSX, Selene built from source), `icons.py` and `logo.png` (the mark), `shots.ps1` (theme captures) |
| `.github/workflows/drydock-windows.yml` | the same build on a hosted Windows runner; the installer is the artifact |

Bundled Roblox tooling: luau-lsp, StyLua, Selene.

## Build it (Windows x64)

Needs node per `.nvmrc`, Python 3 with setuptools, Visual Studio Build Tools with the Spectre-mitigated
libraries, and about 15 minutes after the first `npm ci`.

```
bash build/drydock/build-win32.sh
```

App folder: `../VSCode-win32-x64/Drydock.exe`. Installer: `.build/drydock/DrydockUserSetup-x64-<version>.exe`.
The version is upstream's plus a build stamp; `RELEASE_VERSION=... bash build/drydock/build-win32.sh` pins it.

To work on the extension alone: `npm run compile-extension:drydock-ide` from the root, and
`node tools/check.mjs` inside `extensions/drydock-ide`. `bash extensions/drydock-ide/tools/baketest/run.sh`
checks the Meshy paint bake headless in Edge.

## Keeping up with upstream

Upstream history is in this repo. Merge the next tag (`git merge 1.136.0`), re-apply VSCodium's patch set
where hunks moved (their `patches/` directory is the reference), rebuild.

## Licence

Visual Studio Code is MIT, Microsoft Corporation (`LICENSE.txt`). VSCodium's patches are MIT. Drydock's
changes and the extension are MIT, Maquoketa Research (`extensions/drydock-ide/LICENSE.txt`).
