# build/drydock

The fork's own build, on top of VS Code's gulp tasks (VSCodium's patches, committed in this tree, add the
prepack/packing split and the vsix built-ins).

| File | What |
| --- | --- |
| `build-win32.sh` | app folder and user installer for Windows x64; stamps the version into the build tree only |
| `fetch-builtins.sh` | luau-lsp and StyLua from Open VSX, Selene via `selene-vsix.sh`, into `build/builtin/`; stamps their sha256 into `product.json` for the build |
| `selene-vsix.sh` | builds the Selene extension from source (it is not on Open VSX) |
| `license-rtf.sh` | `LICENSE.rtf` for the Inno installer |
| `icons.py`, `logo.png`, `icons/` | the Maquoketa mark as `.ico`, tiles and installer bitmaps; the outputs live in `resources/win32` and `src/vs/workbench/browser/media/code-icon.svg` |
| `shots.ps1` | launches the built app once per theme on the sample workspace and captures it |
