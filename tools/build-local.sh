#!/usr/bin/env bash
# Build the branded Drydock IDE on this machine with VSCodium's harness: the same steps as
# .github/workflows/fork-windows.yml, so a green run here means the workflow is right.
#
#   mise exec -- bash tools/build-local.sh [harness-dir]      (Git Bash; node, npm and jq come from mise)
#
# Output: <harness>/assets/DrydockUserSetup-x64-<version>.exe. Zip is off (no 7-Zip here).
set -euo pipefail

IDE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${1:-$HOME/dd/harness}"
LOG="$HARNESS/../build-local.log"          # one file, appended, so a watcher can follow across runs

# names the harness substitutes into its patches; the human name lives in fork/product.json
export APP_NAME=Drydock BINARY_NAME=drydock ORG_NAME=Maquoketa-Research
export GH_REPO_PATH=Maquoketa-Research/drydock-ide ASSETS_REPOSITORY=Maquoketa-Research/drydock-ide
export OS_NAME=windows VSCODE_ARCH=x64 VSCODE_QUALITY=stable
export CI_BUILD=no                      # build.sh packs on Windows only when this is "no" (CI splits packing out)
export SHOULD_BUILD=yes SHOULD_BUILD_CLI=no SHOULD_BUILD_REH=no SHOULD_BUILD_REH_WEB=no
export SHOULD_BUILD_ZIP="${SHOULD_BUILD_ZIP:-no}" SHOULD_BUILD_EXE_SYS=no SHOULD_BUILD_EXE_USR=yes
export SHOULD_BUILD_MSI=no SHOULD_BUILD_MSI_NOUP=no
export DISABLE_UPDATE=yes VSCODE_SKIP_NODE_VERSION_CHECK=yes
export NODE_OPTIONS=--max-old-space-size=8192 npm_config_arch=x64 npm_config_target_arch=x64
# node-gyp needs a Python with setuptools; 3.14 has it installed here
export npm_config_python="${npm_config_python:-C:/Users/Dave.MAQUOKETA/AppData/Local/Python/pythoncore-3.14-64/python.exe}"
export PYTHON="$npm_config_python"

exec > >(tee -a "$LOG") 2>&1
echo "== drydock-ide local fork build  $(date)  log: $LOG"
echo "== node $(node --version)  npm $(npm --version)  jq $(jq --version)  python $("$PYTHON" --version)"

echo "== 1/6 extension"
( cd "$IDE" && npm ci --no-audit --no-fund --loglevel=error && npm run -s compile && node tools/check.mjs \
  && npx --no-install @vscode/vsce package --no-dependencies --allow-missing-repository -o drydock-ide.vsix >/dev/null && ls -la drydock-ide.vsix )

cd "$HARNESS"
if [[ ! -d vscode/.git ]]; then
  echo "== 2/6 upstream source (get_repo.sh)"
  rm -rf vscode
  # sourced, not executed: it exports MS_TAG, MS_COMMIT and RELEASE_VERSION, which build.sh needs.
  # It reads variables that may be unset, so nounset is off for the duration.
  set +u; . ./get_repo.sh; set -u
else
  echo "== 2/6 upstream source already present, reusing vscode/ (delete it for a fresh fetch)"
  # get_repo.sh exports these; recompute the same way it does when the checkout is reused
  export MS_TAG="$(jq -r .tag upstream/stable.json | tr -d '\r')" MS_COMMIT="$(jq -r .commit upstream/stable.json | tr -d '\r')"
  export RELEASE_VERSION="${RELEASE_VERSION:-${MS_TAG}$(printf "%04d" $(( $(date +%-j) * 24 + $(date +%-H) )))}"
fi
echo "== MS_TAG=${MS_TAG:-?} MS_COMMIT=${MS_COMMIT:-?} RELEASE_VERSION=${RELEASE_VERSION:-?}"

echo "== 3/6 product.json overlay"
[[ -f product.base.json ]] || cp product.json product.base.json          # VSCodium's overlay, kept pristine
jq -s '.[0] * .[1]' product.base.json "$IDE/fork/product.json" > product.json
# keep upstream's own built-ins (js-debug) ahead of ours; the overlay replaced the array wholesale
jq --slurpfile up vscode/product.json '.builtInExtensions = ($up[0].builtInExtensions // []) + .builtInExtensions' product.json > product.tmp && mv product.tmp product.json
CACHE="${BUILTIN_CACHE:-$HARNESS/../builtin-cache}"          # Open VSX downloads, kept between runs
mkdir -p vscode/build/builtin "$CACHE"
cp "$IDE/drydock-ide.vsix" vscode/build/builtin/drydock-ide.vsix
fetch() { [[ -f "$2" ]] || curl -sSL -o "$2" "$1"; }
fetch "https://open-vsx.org/api/JohnnyMorganz/luau-lsp/win32-x64/1.69.0/file/JohnnyMorganz.luau-lsp-1.69.0@win32-x64.vsix" "$CACHE/luau-lsp-1.69.0-win32-x64.vsix"
fetch "https://open-vsx.org/api/JohnnyMorganz/stylua/1.7.2/file/JohnnyMorganz.stylua-1.7.2.vsix" "$CACHE/stylua-1.7.2.vsix"
cp "$CACHE/luau-lsp-1.69.0-win32-x64.vsix" vscode/build/builtin/luau-lsp.vsix
cp "$CACHE/stylua-1.7.2.vsix" vscode/build/builtin/stylua.vsix
# Selene is not on Open VSX; its extension is built from source once (tools/selene-vsix.sh) into the cache
[[ -f "$CACHE/selene-vscode-1.5.1.vsix" ]] || bash "$IDE/tools/selene-vsix.sh" "$CACHE"
cp "$CACHE/selene-vscode-1.5.1.vsix" vscode/build/builtin/selene.vsix
# every vsix built-in carries the hash of the file it points at
for f in $(jq -r '.builtInExtensions[] | select(.vsix) | .vsix' product.json | tr -d '\r'); do   # Windows jq prints CRLF
  SHA="$(sha256sum "vscode/$f" | cut -d' ' -f1)"
  jq --arg f "$f" --arg sha "$SHA" '(.builtInExtensions[] | select(.vsix == $f) | .sha256) = $sha' product.json > product.tmp && mv product.tmp product.json
done
jq '{nameShort, nameLong, applicationName, dataFolderName, builtIns: (.builtInExtensions | map(.name))}' product.json
# our source patches ride behind VSCodium's (prepare_vscode.sh applies patches/user last)
mkdir -p patches/user && cp "$IDE"/fork/patches/*.patch patches/user/ && ls patches/user

echo "== 4/6 icons"
# prepare_vscode.sh overlays src/stable/* onto the tree (VSCodium's own icons among them), so ours go into that
# overlay, not into vscode/ directly, or they are overwritten a step later
cp "$IDE"/fork/icons/*.ico "$IDE"/fork/icons/*.png "$IDE"/fork/icons/*.bmp src/stable/resources/win32/
# the in-app title bar icon is a separate SVG the workbench stylesheet points at
mkdir -p src/stable/src/vs/workbench/browser/media && cp "$IDE"/fork/icons/code-icon.svg src/stable/src/vs/workbench/browser/media/code-icon.svg

echo "== 5/6 build.sh (patches, npm ci, prepack, packing)  $(date)"
./build.sh

echo "== 6/6 prepare_assets.sh (installer)  $(date)"
./prepare_assets.sh
ls -la assets
echo "== done $(date)"
