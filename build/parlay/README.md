# build/parlay

The fork's own build, on top of VS Code's gulp tasks (VSCodium's patches, committed in this tree, add the
prepack/packing split and the vsix built-ins).

| File | What |
| --- | --- |
| `build-win32.sh` | Parlay app folder and user installer for Windows x64; stamps the version into the build tree only; writes a `.json` sidecar next to the installer for `release.sh` |
| `release.sh` | GitHub release `v<version>` with the installer, then the update manifest `updates/stable/win32/x64/user/latest.json` committed on `main` and mirrored to GitHub; `--dry-run` skips gh and git |
| `fetch-builtins.sh` | luau-lsp and StyLua from Open VSX, Selene via `selene-vsix.sh`, into `build/builtin/`; stamps their sha256 into `product.json` for the build |
| `selene-vsix.sh` | builds the Selene extension from source (it is not on Open VSX) |
| `license-rtf.sh` | `LICENSE.rtf` for the Inno installer |
| `icons.py`, `logo.png` | the spade as `.ico`, tiles and installer bitmaps in `resources/win32`, the in-app icon `src/vs/workbench/browser/media/code-icon.svg`, the title-bar data URIs in `style.css`, the empty-editor letterpress SVGs |
| `shots.ps1` | launches the built app once per theme on the sample workspace and captures it |

## Releasing

Once: `winget install GitHub.cli`, then `gh auth login` (GitHub.com, HTTPS, an account that can write
`Maquoketa-Research/parlay`).

1. On local `main`, `bash build/parlay/build-win32.sh`. It leaves `.build/parlay/ParlayUserSetup-x64-<version>.exe`
   and its `.json` sidecar (the commit, version and target gulp stamped into the installer's product.json, plus
   the build time).
2. `bash build/parlay/release.sh --dry-run` to see the hashes and the manifest it would publish; then
   `bash build/parlay/release.sh`. It creates GitHub release `v<version>` and uploads the installer, writes
   `updates/stable/win32/x64/user/latest.json` pointing at that asset, commits it on `main`, and mirrors and
   pushes it as GitHub `main` the same way every other commit goes (commit-tree onto `parlay`, push `parlay:main`).

What users see: installed Parlays fetch
`https://raw.githubusercontent.com/Maquoketa-Research/parlay/main/updates/stable/win32/x64/user/latest.json`
30 seconds after launch and hourly (`update.mode` is `default`; `manual` would make it Help > Check for Updates
only, `none` turns it off). When the manifest's `productVersion` is newer than theirs, Parlay downloads the
installer in the background, verifies its sha256, runs it silently, and the Help menu and title bar offer
**Restart to Update**. Nothing is offered while `update.mode` is `none`, when Parlay runs elevated, or in a
build without `updateUrl` and `commit` in product.json.
