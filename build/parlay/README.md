# build/parlay

The fork's own build, on top of VS Code's gulp tasks (VSCodium's patches, committed in this tree, add the
prepack/packing split and the vsix built-ins).

| File | What |
| --- | --- |
| `build-win32.sh` | Parlay app folder and user installer for Windows x64; stamps the version into the build tree only; writes a `.json` sidecar next to the installer for `release.sh` |
| `build-darwin.sh` | Parlay.app for macOS (arm64 default, `VSCODE_ARCH=x64` for Intel), ad-hoc signed, as a zip and a DMG in `.build/parlay/`, plus its update manifest `latest-darwin-<arch>.json`; runs on the hosted Mac of `.github/workflows/mac.yml` (see macOS below) |
| `release.sh` | GitHub release `v<version>` with the installer, then the update manifest `updates/stable/win32/x64/user/latest.json` (and any darwin manifest the Mac workflow put on the release) committed on `main` and mirrored to GitHub; `--dry-run` skips gh and git |
| `fetch-builtins.sh` | luau-lsp (for `VSIX_TARGET`, default `win32-x64`) and StyLua from Open VSX, Selene via `selene-vsix.sh`, into `build/builtin/`; stamps their sha256 into `product.json` for the build |
| `selene-vsix.sh` | builds the Selene extension from source (it is not on Open VSX) |
| `license-rtf.sh` | `LICENSE.rtf` for the Inno installer |
| `sign.sh`, `sign.ps1` | Authenticode signing (below); `sign.sh` is the Git Bash entry, `sign.ps1` does the work and is also what Inno Setup calls for the setup exe and the uninstaller |
| `icons.py`, `logo.png` | the spade as `.ico`, tiles and installer bitmaps in `resources/win32`, the in-app icon `src/vs/workbench/browser/media/code-icon.svg`, the title-bar data URIs in `style.css`, the empty-editor letterpress SVGs |
| `icons.py`, `logo.png` | the spade as `.ico`, tiles and installer bitmaps in `resources/win32`, the Mac bundle icon `resources/darwin/code.icns`, the in-app icon `src/vs/workbench/browser/media/code-icon.svg`, the title-bar data URIs in `style.css`, the empty-editor letterpress SVGs |
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

## Signing

Unsigned, the installer and `Parlay.exe` hit SmartScreen's "Windows protected your PC, unknown publisher" on
every tester's machine. `build-win32.sh` signs when one of the credentials below is in the environment and
otherwise prints `unsigned build (set PARLAY_SIGN_... to sign)` and carries on, so a plain build is unchanged.

Where it happens, the same two points as upstream's `build/azure-pipelines/win32/codesign.ts`:

1. After `vscode-win32-x64-inno-updater` (which rcedits `tools/inno_updater.exe`; signing before it would break
   that signature), `sign.sh ../VSCode-win32-x64` signs every `*.exe`, `*.dll` and `*.node` under the app folder:
   `Parlay.exe`, Electron's dlls, the inno updater, the native modules under `resources/app/node_modules.asar.unpacked`,
   the extensions' server exes. Files that already carry a valid signature (Microsoft's `vcruntime140.dll`,
   `OpenConsole.exe`, PSReadLine) keep it; a Microsoft signature is better than ours.
2. `vscode-win32-x64-user-setup -- --sign`. `--sign` defines `Sign` in `build/win32/code.iss`, whose `SignTool=esrp`
   makes Inno Setup run the sign tool named "esrp" on the uninstaller and then on the finished setup exe;
   `build-win32.sh` sets `VSCODE_INNO_SIGN_CMD` so that tool is `sign.ps1` instead of Microsoft's ESRP client (the one
   line changed in `build/gulpfile.vscode.win32.ts`). Inno's own path rather than signing the moved exe afterwards
   because it is the only way the uninstaller gets signed. `sign.sh --verify` (`signtool verify /pa /v`) then runs on
   `.build/parlay/ParlayUserSetup-x64-<version>.exe` and fails the build if the chain does not check out.

Every signature is SHA-256 with an RFC 3161 timestamp, so it outlives the certificate.

| Variable | |
| --- | --- |
| `PARLAY_SIGN_THUMBPRINT` | SHA-1 thumbprint of a code-signing certificate in `Cert:\CurrentUser\My`. This is how a hardware token (SafeNet, YubiKey) shows up once its middleware is installed. `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert` lists them |
| `PARLAY_SIGN_PFX` + `PARLAY_SIGN_PASSWORD` | a `.pfx` file. CAs have not issued exportable keys since 2023 (below), so this is for self-signed tests |
| `PARLAY_SIGN_AZURE_METADATA` | path of the metadata json for Azure Trusted Signing (`signtool /dlib /dmdf`). Needs the `Microsoft.Trusted.Signing.Client` NuGet package, whose `bin\x64\Azure.CodeSigning.Dlib.dll` is found under `~\.nuget\packages` or named by `PARLAY_SIGN_AZURE_DLIB`, and an Azure login: `az login`, or `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| `PARLAY_SIGN_TIMESTAMP` | RFC 3161 server. Default `http://timestamp.digicert.com`, or `http://timestamp.acs.microsoft.com` with Trusted Signing |
| `PARLAY_SIGNTOOL` | `signtool.exe`. Default: the newest `C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\signtool.exe` from the Windows SDK; `/dlib` needs a 2023 or later SDK |

The Trusted Signing metadata json (endpoint per region: `eus`, `wus2`, `weu`, `neu`, ...):

```json
{
  "Endpoint": "https://eus.codesigning.azure.net",
  "CodeSigningAccountName": "<your Trusted Signing account>",
  "CertificateProfileName": "<your certificate profile>"
}
```

Commands:

```bash
PARLAY_SIGN_THUMBPRINT=<40 hex chars> bash build/parlay/build-win32.sh          # token or store certificate
PARLAY_SIGN_AZURE_METADATA="C:\Users\<you>\.parlay\trusted-signing.json" bash build/parlay/build-win32.sh
bash build/parlay/sign.sh ../VSCode-win32-x64                                   # sign a folder by hand
bash build/parlay/sign.sh --verify .build/parlay/ParlayUserSetup-x64-<version>.exe
```

What to buy, one of:

- **An OV code-signing certificate** from DigiCert (about $500 a year), Sectigo (about $250 to $400, around $200
  through resellers) or SSL.com (about $250). Since June 2023 the CA/Browser Forum requires the private key on
  FIPS 140-2 Level 2 hardware, so the CA ships a USB token (about $50 to $100, sometimes included) or keeps the key
  in its cloud HSM (DigiCert KeyLocker, SSL.com eSigner; monthly or per-signature fees). No plain `.pfx` any more.
  With a token the certificate appears in `Cert:\CurrentUser\My` and `PARLAY_SIGN_THUMBPRINT` is the mode; the
  build needs the token plugged into the build machine and its PIN typed or cached, so a CI runner would need the
  cloud HSM flavour.
- **An EV code-signing certificate**, same CAs, about $300 to $700 a year, always on hardware, with stricter
  organisation validation (legal existence, address, phone). The one thing EV buys is SmartScreen reputation from
  the first download.
- **Azure Trusted Signing**: $9.99 a month (Basic, 5,000 signatures a month) on an Azure subscription, plus identity
  validation of the organisation; Public Trust wants three or more years of verifiable business history, which may
  rule Maquoketa Research out until then. Microsoft-issued short-lived certificates, key in Microsoft's HSM, works
  from any machine after `az login`. The cheap, CI-friendly option.

What SmartScreen does with it: reputation is earned per signing certificate (and per file hash) from clean
downloads and runs. Unsigned files can never build any. An OV-signed installer still warns for the first weeks
or first few hundred downloads, with the publisher named instead of "unknown", then goes quiet for every later
build signed with that certificate; renewals from the same CA mostly inherit it. EV is trusted on day one.
Trusted Signing ties reputation to the validated identity rather than the rotating certificates, and in practice
warnings stop quickly. Parlay's own updater runs the downloaded installer itself without a Mark of the Web, so
SmartScreen only matters for the first install from the browser.

To exercise the mechanics without buying anything (SmartScreen still warns, the chain is untrusted):

```powershell
$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Parlay Test" -CertStoreLocation Cert:\CurrentUser\My
$env:PARLAY_SIGN_THUMBPRINT = $c.Thumbprint          # then build, or bash build/parlay/sign.sh <file>
Get-AuthenticodeSignature <file>                     # SignerCertificate CN=Parlay Test, Status UnknownError: expected
Remove-Item "Cert:\CurrentUser\My\$($c.Thumbprint)"
```
## macOS

### Local Mac development

To run from a checkout, use the Node version in `.nvmrc`, Python 3 with setuptools, and Xcode command line
tools. This builds the editor and its extensions without the release build's minification step:

```bash
npm ci --no-audit --no-fund
VSIX_TARGET="darwin-$(node -p 'process.arch')" bash build/parlay/fetch-builtins.sh
npm run gulp copy-codicons compile-api-proposal-names compile-extension-point-names
npm run transpile-client
npm run build-fast-extensions
node build/lib/preLaunch.ts
codesign --force --deep --sign - .build/electron/Parlay.app
codesign --verify --deep --strict .build/electron/Parlay.app
```

`fetch-builtins.sh` updates the local VSIX hashes in `product.json`; these platform-specific/generated hash
changes should not be committed as source changes.

After preparation, double-click `build/parlay/run-darwin.command` in Finder, or run it with a project folder:

```bash
bash build/parlay/run-darwin.command /path/to/game
```

The launcher also recognizes an official Node distribution extracted under
`.build/toolchains/node-v<version>-darwin-<arch>/`, so a repo-local toolchain works from Finder. It reuses
compiled outputs; after editing sources, rerun `npm run transpile-client` and `npm run build-fast-extensions`
before reopening the app. This is a local development app, not a signed distributable installer.

The launcher keeps its profile in `.build/parlay-local`. For local editing without OAuth build credentials,
set `"parlay.requireSignIn": false` in `.build/parlay-local/User/settings.json`. Roblox account operations still
require a configured OAuth app and sign-in.

For the classic Windows appearance (flat panels, rectangular tabs, gray title bar, blue status bar), use:

```json
{
  "workbench.colorTheme": "Dark+",
  "parlay.roundedChrome": false
}
```

With `parlay.stackedHeader` enabled (the default), macOS uses the second row for a game project picker,
Script Sync setup, Changes, Problems, Open Studio, Aqua, and Chat. File, Edit, and the other standard menus
stay in the macOS system menu bar. The Parlay logo sits left of the native window buttons in the top row.
Open Studio launches Roblox Studio for
playtesting; it does not start or stop a game. Turning the setting off restores a single title row.

Choose **Parlay Glass** with Preferences: Color Theme for macOS vibrancy behind the sidebar, title bar, and
panels. The editor stays opaque for readability. Switching to another theme restores solid chrome; the
Windows version uses acrylic. macOS accessibility settings can reduce the transparency effect.

### Parlay Chat

**Chat** is Parlay's own sidebar interface for Claude Code and Codex. It uses the agents' existing CLI
logins; there is no separate Chat account. The composer shows connection status and provides sign-in and
refresh actions. macOS discovery checks PATH, common local/Homebrew locations, and the Codex CLI bundled
with an existing desktop installation. Explicit `parlay.claudeCommand` and `parlay.codexCommand` settings
still take priority.

Attach the active file or selected code with the paperclip (up to 20,000 characters), then send with Enter.
Shift+Enter adds a line. Drafts survive hiding/reloading the view; a refused send keeps the draft. You can
copy messages and code blocks, expand tool output, and switch agents within a conversation. Claude streams
text; Codex currently delivers completed message events. Chat requires an open, trusted project to run agents.

**New chat** archives the current conversation. **Conversation history** reopens saved chats for this project,
including each agent's session identifiers. Transcripts and attached code are stored under Parlay's extension
global storage, in `chat/`. The interface follows Dark, Paper, and Glass themes.

### Release builds

The release Mac build is a GitHub Actions job: `.github/workflows/mac.yml` runs
`build/parlay/build-darwin.sh` on a hosted runner (`macos-14`, Apple silicon; `macos-15-intel` when `arch` is
`x64`). It starts on every `v*` tag, so `release.sh` starting the Windows release starts the Mac one, and by hand
from Actions > Parlay (macOS) > Run workflow (inputs: `arch`, and `release` to upload to the GitHub release
`v<version>`, created when missing). Repository secrets it reads, both optional: `PARLAY_ROBLOX_CLIENT_SECRET`
and `PARLAY_DISCORD_CLIENT_SECRET`, the same one-liners as `~/.parlay/<provider>-client-secret` on the Windows
build box; without them the build has no OAuth login. Untimed yet (the Windows job takes about two hours); the
artifact `Parlay-darwin-<arch>` holds:

- `Parlay-darwin-<arch>-<version>.zip`: `Parlay.app` zipped with `ditto --keepParent`, the shape Electron's
  updater installs from, and what the update manifest points at.
- `Parlay-darwin-<arch>-<version>.dmg`: the same app with an Applications shortcut, for people who expect a DMG.
- `latest-darwin-<arch>.json`: the update manifest for that zip (`updates/stable/darwin/<arch>/latest.json`).

The gulp tasks are the darwin twins of the Windows ones (`vscode-min-prepack`, then
`vscode-darwin-<arch>-min-packing`, both in `build/gulpfile.vscode.ts`), after `policyGenerator ... darwin`;
`fetch-builtins.sh` takes the `darwin-<arch>` luau-lsp vsix (`VSIX_TARGET`), StyLua and Selene are
platform-independent and Selene is still built from source (Node only, no Rust).

**Opening it.** The app is ad-hoc signed (`codesign --sign -`: Apple silicon runs no arm64 code without some
signature, and gulp's edits had broken the seal Electron ships with) but not Developer ID signed or notarized, so
Gatekeeper refuses the first open of a downloaded copy. Either clear the download flag,
`xattr -dr com.apple.quarantine /Applications/Parlay.app`, or open once, then System Settings > Privacy &
Security > **Open Anyway** (on macOS 14 and older, right-click > Open also works).

**Updates.** A Mac Parlay asks `${updateUrl}/stable/darwin/<arch>/latest.json` (`createUpdateURL` in
`src/vs/platform/update/electron-main/abstractUpdateService.ts`, `process.arch`, no target segment) and compares
`productVersion` with its own, like Windows. When newer, `updateService.darwin.ts` hands the same URL to
Electron's `autoUpdater` (Squirrel.Mac), which reads the manifest's `url` and installs the zip in place. Squirrel
only installs a zip whose app carries the same Developer ID as the running one, so **until Parlay is signed the
Mac build cannot update itself**: the check runs, the download fails with a code-signature error, and only Help >
Check for Updates shows it. The manifest is still right for that day; until then the `updates/stable/darwin/`
manifests are informational and people download the new zip themselves.

**Releasing.** `release.sh` creates the tag, the Mac build follows, and the workflow's `release` job uploads the
zip, the DMG and `latest-darwin-<arch>.json` to that release. Once it is done, on local `main`,
`bash build/parlay/release.sh` again: it finds nothing new to upload, downloads the darwin manifest from the
release, writes `updates/stable/darwin/<arch>/latest.json` and commits and mirrors it like the Windows one. Intel:
Run workflow with `arch` `x64` and `release` on, then the same re-run.

**Signing later.** An Apple Developer Program membership gives a Developer ID Application certificate; exported
as a `.p12` and stored as a secret, the job would import it into a temporary keychain, sign with upstream's
`build/darwin/sign.ts` (hardened runtime, the entitlements in `build/azure-pipelines/darwin/*-entitlements.plist`),
submit the zip with `xcrun notarytool submit --wait` and staple the ticket (`xcrun stapler staple`); VSCodium's
`build/osx/prepare_assets.sh` is a working model of exactly those steps. That removes the Gatekeeper prompt and
lets Squirrel install updates.

**Not done yet on Mac.** The extension activates cleanly (its Windows-only paths are behind `process.platform`
checks or `LOCALAPPDATA` guards) but Studio integration is Windows-shaped: Studio's local plugins live in
`~/Documents/Roblox/Plugins` on a Mac (the luau-lsp installer looks in `%LOCALAPPDATA%\Roblox\Plugins`),
the Studio MCP is started through `%LOCALAPPDATA%\Roblox\mcp.bat` and the Script Sync record and open-Studio list are
read from the registry and PowerShell. Each says so instead of
failing, and each is a follow-up.

### Mac automatic Script Sync setup

Use **Script Sync → Set up folders automatically…** for an open project, or
**Add Roblox Studio Project** to create/open its folder. Confirm the published
place ID, save the place, and quit Studio with **⌘Q** when prompted. Closing only
the document window does not stop Studio's cached preference writes.

Parlay reads Studio's existing `File_Sync_Persistence_Record_V1` slot, preserves
all current mappings, adds missing core services, writes the three relevant keys
through `defaults`/CFPreferences, verifies them, and reopens the place. A JSON
backup of the original keys is stored in Parlay's extension global storage under
`sync-backups`; its full path is logged. Failed writes roll back while Studio is
still closed. No direct plist replacement or preference-daemon termination is used.

StarterGui, StarterPlayerScripts and StarterCharacterScripts need real UniqueIds.
Parlay looks for a matching recovery file or Open Cloud IDs; otherwise select a
saved binary `.rbxl` copy with the same Workspace ID, or choose **Core Services
Only**. Existing mappings, including mappings to other folders, are retained.
Studio's conflict dialog remains authoritative when local files already exist.

Validation covers guards, merging, backup and rollback with fixtures, and native
CFPreferences round-tripping in an isolated test domain. The real Studio
close/write/reopen cycle still needs a saved project run to verify export behavior.

## QA box

The Studio automation and play agents run on a dedicated Windows PC, not on a developer's machine. `qa-box.ps1`
(run elevated) installs the tools (git, gh, Tailscale, node, Roblox Studio, Claude Code), turns off sleep, clones
this repo to `~\parlay-qa\parlay`, installs the latest Parlay release and configures a GitHub Actions self-hosted
runner with labels `self-hosted, windows, qa, studio`. `.github/workflows/qa.yml` targets those labels; its smoke
job proves the box.

Three things the script leaves to a person, because they are remote access and autostart:

1. Tailscale: `& "C:\Program Files\Tailscale\tailscale.exe" up`, then tell the driver the machine's Tailscale name.
2. OpenSSH server, reachable over Tailscale only, with the driver's public key (an administrator's keys live in
   `%ProgramData%\ssh\administrators_authorized_keys`):
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Set-Service sshd -StartupType Automatic; Start-Service sshd
   New-NetFirewallRule -DisplayName "SSH (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress 100.64.0.0/10 -Action Allow
   Add-Content "$env:ProgramData\ssh\administrators_authorized_keys" "<driver public key>"; icacls "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
   ```
3. The runner at logon, in the desktop session (never `svc.cmd install`: a service has no desktop and Studio
   cannot play): Task Scheduler, trigger "At log on" for the QA user, action `~\parlay-qa\runner\run.cmd`, no time
   limit, restart on failure. Keep the box logged in (auto sign-in) so the task has a desktop.

### QA runner

`extensions/parlay/qa/play.mjs` (Node 24, no dependencies; it ships inside the extension) drives Studio through
Roblox's own Studio MCP server (`%LOCALAPPDATA%\Roblox\mcp.bat`): finds or opens the place, starts Play, and each
step probes the Server (`probe.server.luau`: player, health, position, leaderstats, nearest interactables) and
the Client (`probe.client.luau`: visible GUI buttons), picks an action, acts through `user_mouse_input` /
`user_keyboard_input` / `execute_luau`, diffs `get_console_output`, and screenshots every 10 steps and on each
new error. Errors are grouped by fingerprint (numbers and ids stripped) with the five actions before first
sight; five steps with no movement, no console line and no GUI change is a stuck event. Play is stopped on the
way out, Ctrl+C included. The report lands in `.build/qa/<timestamp>/` as `report.json`, `report.md`,
screenshots and `aqua-ingest.json` (the batch `AquaChatRelay` would post; it is sent to `/api/ingest/roblox`
when `--aqua-url`/`--aqua-key` or `PARLAY_AQUA_URL`/`PARLAY_AQUA_KEY` are set).

By hand on the box (the MCP seat is exclusive per machine, so no other MCP client may be connected to Studio):

```powershell
node extensions/parlay/qa/play.mjs --place <id> --minutes 5      # --universe <u> when the place is not open yet
```

Exit codes: 0 clean, 2 findings (errors or stuck events), 1 runner failure (no Studio within 90 s, seat taken,
Play did not start, MCP timeout). The `play` job in `qa.yml` fails on both 1 and 2 and puts `report.md` in the
step summary. The policy is `qa/policy.mjs`: `decide(state, history) → action` where `state` is
`{ server, client, stuck }` (the two probe JSONs), `history` the actions so far, and `action` one of
`{ kind: "click", path }`, `{ kind: "interact", path, class, position }`, `{ kind: "walk", key, ms, jump }`.
The default is scripted (unclicked button, else nearest unvisited interactable, else random walk);
`PARLAY_QA_POLICY=jev` loads `policy-jev.mjs`. `node --no-warnings qa/qa-check.mjs` (in `npm run check`) plays
the mock server (`PARLAY_QA_MCP=mock`) end to end.

