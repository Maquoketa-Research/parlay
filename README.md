# Parlay

A fork of [Visual Studio Code](https://github.com/microsoft/vscode) for Roblox game development with Claude in
the editor: you write the game's structure, Claude writes the hard parts. See the code, see the code Claude
writes, right-click to act on a selection, and keep Aqua, Meshy and Sonar in the right sidebar. Roblox Studio
stays the editor for the world; Parlay works on the Script Sync folder.

Three looks, one setting: **Parlay Dark** (default), **Parlay Glass** (real Windows acrylic), **Parlay Paper**.

## What is in the tree

| Path | What |
| --- | --- |
| everything else | Visual Studio Code at the upstream tag in `package.json`, with [VSCodium](https://github.com/VSCodium/vscodium)'s build patches applied (telemetry out, Open VSX as the gallery, update feed off, the app renamed) and Parlay's own changes on top: glass chrome, the two-row header, the look (`src/vs/workbench/browser/media/style.css`), `product.json`, the icons under `resources/win32` |
| `extensions/parlay/` | the Parlay extension, built in like `git` or `markdown-language-features`: the Claude right-click actions and skills, the Aqua, Meshy and Sonar sidebars, the themes, the Script Sync helpers ([its README](extensions/parlay/README.md)) |
| `build/parlay/` | the fork's build: `build-win32.sh` (app and installer), `fetch-builtins.sh` (luau-lsp and StyLua from Open VSX, Selene built from source), `icons.py` and `logo.png` (the spade, every icon), `shots.ps1` (theme captures), `squash-upstream.sh` (one-time history squash, see below) |
| `.github/workflows/parlay-windows.yml` | the same build on a hosted Windows runner; the installer is the artifact |

Bundled Roblox tooling: luau-lsp, StyLua, Selene.

## Build it (Windows x64)

Needs node per `.nvmrc`, Python 3 with setuptools, Visual Studio Build Tools with the Spectre-mitigated
libraries, and about 15 minutes after the first `npm ci`.

```
bash build/parlay/build-win32.sh
```

App folder: `../VSCode-win32-x64/Parlay.exe`. Installer: `.build/parlay/ParlayUserSetup-x64-<version>.exe`.
The version is upstream's plus a build stamp; `RELEASE_VERSION=... bash build/parlay/build-win32.sh` pins it.

To work on the extension alone: `npm run compile-extension:parlay-ide` from the root, and
`node tools/check.mjs` inside `extensions/parlay`. `bash extensions/parlay/tools/baketest/run.sh`
checks the Meshy paint bake headless in Edge.

## What is not in the tree

Only the Windows x64 desktop app is built, so upstream's other targets are gone: the macOS, Linux, server
(reh), web and tunnel CLI builds and their resources, Azure Pipelines, the devcontainer, the smoke and
integration test harnesses under `test/`, the test-only and Jupyter/PHP/npm-task/tunnel/Microsoft-account
extensions, and grammars for languages a Luau editor does not open. Built-in extensions are whatever
folders sit under `extensions/`; deleting one needs no list edit unless it is in `build/npm/dirs.ts`,
`build/gulpfile.extensions.ts` or the media list in `build/lib/extensions.ts`. Upstream's unit tests under
`src/**/test` are still here; the shipped app never includes them.

## Keeping up with upstream

Upstream is meant to be one squashed snapshot commit ("Visual Studio Code 1.135.0"), not the 164k-commit
history, which is what took the repository to 1.2 GB. `bash build/parlay/squash-upstream.sh` does that
rewrite once (it keeps the old tip under `refs/backup/`); after it, force-push and re-clone.

To merge a newer tag afterwards, tell git that the snapshot stands in for the upstream commit it was taken
from, then merge as before and re-apply VSCodium's patch set where hunks moved (their `patches/` directory
is the reference):

```
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream --tags
git replace $(git log --grep='^Visual Studio Code 1.135.0' --format=%H --max-parents=0) 08d4889f9ec4a1685d257b9b95de036c8e1ce1e5
git merge 1.136.0
```

## Licence

Visual Studio Code is MIT, Microsoft Corporation (`LICENSE.txt`). VSCodium's patches are MIT. Parlay's
changes and the extension are MIT, Maquoketa Research (`extensions/parlay/LICENSE.txt`).
