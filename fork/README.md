# The fork

Drydock IDE is a branded build of VS Code. The product is the extension in this repo (right-click
Claude actions, the Drydock panel, the three themes); the fork exists for the name in the title bar,
the icon, the installer, the Open VSX gallery, the bundled Luau tooling, and the glass window.

Follow `Documents/ide-designs-2026-09-14/research/01-vscode-fork.md` for the sourced details. Summary:

1. Fork the **VSCodium build harness** (github.com/VSCodium/vscodium), not microsoft/vscode. Branding is a
   `jq` edit of `product.json` in `prepare_vscode.sh`; the values are `fork/product.json` here. Icons are
   binary swaps under `resources/win32/`. No source patches for v1.
2. Build on a Windows runner: Node from upstream `.nvmrc` (24.x), Python 3.11, VS Build Tools, Git Bash, jq,
   7-Zip. Gulp chain `vscode-min-prepack`, `vscode-win32-x64-min-packing`, `vscode-win32-x64-inno-updater`,
   `vscode-win32-x64-user-setup`. About 125 minutes on a hosted runner.
3. Built-ins: `builtInExtensions` in `product.json` pulls luau-lsp, StyLua and Claude Code from Open VSX at
   build time. **Selene is not on Open VSX**: build its `.vsix` from source and add it with the `vsix` field,
   and never list the absent marketplace ID (squat risk). This repo's own extension is bundled the same way.
4. Updates: ride VSCodium's static `latest.json` patch and publish installers to GitHub Releases. Rebase on
   upstream monthly; skip the weekly builds.
5. **Glass window (later):** the Glass theme's alpha chrome only becomes real glass when the Electron window
   is created with `backgroundMaterial: "acrylic"` (Windows 11) and a transparent background. That is one
   patch in `src/vs/platform/windows/electron-main/windowImpl.ts`, gated on a setting. Do it after the first
   plain build ships; a wrong patch there is a blank window.

CI: a `build-windows.yml` comes with the first real build, written against the harness as it stands that
day rather than guessed now.
