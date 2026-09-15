#!/usr/bin/env bash
# Build Parlay for Windows x64 from this tree: the app folder (../VSCode-win32-x64) and the user installer
# (.build/parlay/ParlayUserSetup-x64-<version>.exe). VS Code's own gulp tasks do the work; VSCodium's build
# patches (committed here) add the prepack/packing split and the vsix built-ins.
#
#   bash build/drydock/build-win32.sh                  (Git Bash; node per .nvmrc, Python 3 with setuptools,
#                                                       VS Build Tools with the Spectre-mitigated libs)
#   RELEASE_VERSION=1.135.0100 bash build/drydock/build-win32.sh   to pin the version stamp
#
# About 15 minutes on a big machine after the first npm ci. Close a running Parlay started from the output
# folder first: packing deletes and rewrites it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# names the patched build reads (file names, mutexes, the exe basename); the human name is in product.json
export APP_NAME=Parlay BINARY_NAME=parlay ORG_NAME=Maquoketa-Research
export GH_REPO_PATH=Maquoketa-Research/parlay ASSETS_REPOSITORY=Maquoketa-Research/parlay
export OS_NAME=windows VSCODE_ARCH="${VSCODE_ARCH:-x64}" VSCODE_QUALITY=stable
export DISABLE_UPDATE=yes VSCODE_SKIP_NODE_VERSION_CHECK=yes VSCODE_PUBLISH_COUNTER=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" npm_config_arch="$VSCODE_ARCH" npm_config_target_arch="$VSCODE_ARCH"
# node-gyp wants a Python with setuptools; Dave's box has 3.14 at this path, CI sets npm_config_python itself
DEFAULT_PY="C:/Users/$USERNAME/AppData/Local/Python/pythoncore-3.14-64/python.exe"
if [[ -z "${npm_config_python:-}" && -f "$DEFAULT_PY" ]]; then export npm_config_python="$DEFAULT_PY"; fi
[[ -n "${npm_config_python:-}" ]] && export PYTHON="$npm_config_python"

# version: upstream's number plus a build stamp (day of year * 24 + hour, VSCodium's scheme), unless given.
# It is written into the build tree only; package.json in git stays at upstream's version.
BASE_VERSION="$(node -p "require('./package.json').version")"
export RELEASE_VERSION="${RELEASE_VERSION:-${BASE_VERSION}$(printf "%04d" $(( $(date +%-j) * 24 + $(date +%-H) )))}"
export BUILD_SOURCEVERSION="$(git rev-parse HEAD)"
echo "== Parlay ${RELEASE_VERSION} from ${BUILD_SOURCEVERSION:0:9}  $(date)"
echo "== node $(node --version)  npm $(npm --version)"

restore() { git checkout -q -- package.json product.json 2>/dev/null || true; }
trap restore EXIT
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version=process.env.RELEASE_VERSION;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

echo "== built-in extensions"
bash build/drydock/fetch-builtins.sh

echo "== npm ci  $(date)"
npm ci --no-audit --no-fund

echo "== compile and minify  $(date)"
npm run gulp vscode-min-prepack

echo "== package  $(date)"
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc win32
npm run gulp "vscode-win32-${VSCODE_ARCH}-min-packing"

echo "== installer  $(date)"
bash build/drydock/license-rtf.sh
npm run gulp "vscode-win32-${VSCODE_ARCH}-inno-updater"
npm run gulp "vscode-win32-${VSCODE_ARCH}-user-setup"
mkdir -p .build/parlay
mv ".build/win32-${VSCODE_ARCH}/user-setup/VSCodeSetup.exe" ".build/parlay/ParlayUserSetup-${VSCODE_ARCH}-${RELEASE_VERSION}.exe"
ls -la .build/parlay
echo "== done  $(date)   app: $(cd .. && pwd)/VSCode-win32-${VSCODE_ARCH}/Parlay.exe"
