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
| `sign.sh`, `sign.ps1` | Authenticode signing (below); `sign.sh` is the Git Bash entry, `sign.ps1` does the work and is also what Inno Setup calls for the setup exe and the uninstaller |
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
