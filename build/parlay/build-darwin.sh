#!/usr/bin/env bash
# Build Parlay for macOS from this tree: the app bundle (../VSCode-darwin-<arch>/Parlay.app), a zip of it
# (.build/parlay/Parlay-darwin-<arch>-<version>.zip, the shape Electron's macOS updater installs from), a DMG,
# and the update manifest for that zip. VS Code's own gulp tasks do the work, as in build-win32.sh.
#
#   bash build/parlay/build-darwin.sh                 (on a Mac: node per .nvmrc, Python 3, Xcode command line tools)
#   VSCODE_ARCH=x64 bash build/parlay/build-darwin.sh              Intel; arm64 (Apple silicon) is the default
#   RELEASE_VERSION=1.135.0100 bash build/parlay/build-darwin.sh   to pin the version stamp
#   bash build/parlay/build-darwin.sh --pack-only     re-package from the compiled tree (no npm ci, no compile)
#
# Nobody here has a Mac: .github/workflows/mac.yml runs this on a hosted runner, and that is where it is tested.
# The app is ad-hoc signed only (README.md, macOS): it runs once the quarantine flag is cleared, and it cannot
# update itself in place until it carries a Developer ID signature.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# the same names build-win32.sh exports (the fork's gulp reads BUILD_SOURCEVERSION and VSCODE_SKIP_NODE_VERSION_CHECK;
# the rest are VSCodium's, kept so the two scripts read alike); the human name is in product.json
export APP_NAME=Parlay BINARY_NAME=parlay ORG_NAME=Maquoketa-Research
export GH_REPO_PATH=Maquoketa-Research/parlay ASSETS_REPOSITORY=Maquoketa-Research/parlay
export OS_NAME=osx VSCODE_ARCH="${VSCODE_ARCH:-arm64}" VSCODE_QUALITY=stable
export VSCODE_SKIP_NODE_VERSION_CHECK=yes VSCODE_PUBLISH_COUNTER=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" npm_config_arch="$VSCODE_ARCH" npm_config_target_arch="$VSCODE_ARCH"
[[ -n "${npm_config_python:-}" ]] && export PYTHON="$npm_config_python"

# version: upstream's number plus a build stamp (day of year * 24 + hour, VSCodium's scheme), unless given.
# 10# because BSD date pads with zeros and bash would read 08 as octal. Written into the build tree only.
BASE_VERSION="$(node -p "require('./package.json').version")"
export RELEASE_VERSION="${RELEASE_VERSION:-${BASE_VERSION}$(printf "%04d" $(( 10#$(date +%j) * 24 + 10#$(date +%H) )))}"
export BUILD_SOURCEVERSION="$(git rev-parse HEAD)"
echo "== Parlay ${RELEASE_VERSION} darwin-${VSCODE_ARCH} from ${BUILD_SOURCEVERSION:0:9}  $(date)"
echo "== node $(node --version)  npm $(npm --version)"

restore() { git checkout -q -- package.json product.json 2>/dev/null || true; rm -f extensions/parlay/secrets.json; }
trap restore EXIT
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version=process.env.RELEASE_VERSION;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

# The OAuth client secrets ride in the build, never in the tree: ~/.parlay/<provider>-client-secret (one line each;
# mac.yml writes them from the repository secrets) becomes extensions/parlay/secrets.json (gitignored, removed on exit).
node -e "const fs=require('fs'),p=require('path'),h=require('os').homedir();const out={};for(const id of ['roblox','discord']){const f=p.join(h,'.parlay',id+'-client-secret');if(fs.existsSync(f))out[id]=fs.readFileSync(f,'utf8').trim();}fs.writeFileSync('extensions/parlay/secrets.json',JSON.stringify(out)+'\n');console.log('== client secrets baked: '+(Object.keys(out).join(', ')||'none'))"

echo "== built-in extensions"
VSIX_TARGET="darwin-${VSCODE_ARCH}" bash build/parlay/fetch-builtins.sh

if [[ "${1:-}" != "--pack-only" ]]; then
  echo "== npm ci  $(date)"
  npm ci --no-audit --no-fund

  echo "== compile and minify  $(date)"
  npm run gulp vscode-min-prepack
fi

echo "== package  $(date)"
rm -f .build/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.*.node   # a Windows binary in js-debug; VSCodium drops it from Mac builds too
npm run copy-policy-dto --prefix build
node build/lib/policies/policyGenerator.ts build/lib/policies/policyData.jsonc darwin
npm run gulp "vscode-darwin-${VSCODE_ARCH}-min-packing"

APP_DIR="$(cd .. && pwd)/VSCode-darwin-${VSCODE_ARCH}"
APP="$APP_DIR/Parlay.app"
echo "== ad-hoc signature  $(date)"
# Apple silicon will not run arm64 code with no signature at all, and gulp's edits to the bundle broke the seal
# Electron shipped with. An ad-hoc signature (identity "-") makes the bundle consistent again; it is not a
# Developer ID, so Gatekeeper still asks on first open (README.md, macOS).
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "== zip and dmg  $(date)"
mkdir -p .build/parlay
OUT=".build/parlay/Parlay-darwin-${VSCODE_ARCH}-${RELEASE_VERSION}"
rm -f "$OUT.zip" "$OUT.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT.zip"
ln -sfn /Applications "$APP_DIR/Applications"   # drag-to-install target inside the DMG window
hdiutil create -quiet -volname Parlay -srcfolder "$APP_DIR" -ov -format UDZO "$OUT.dmg"
rm -f "$APP_DIR/Applications"

# The update manifest for this zip, the shape release.sh writes for Windows (VSCodium's versions-repo shape; the
# macOS client needs url, version and productVersion, reads timestamp for update.minReleaseAge). commit, version
# and quality are what gulp stamped into the app. mac.yml puts it on the release as latest-darwin-<arch>.json and
# release.sh commits it as updates/stable/darwin/<arch>/latest.json.
node -e "const fs=require('fs'),c=require('crypto');const [app,zip,url,out]=process.argv.slice(1);const p=JSON.parse(fs.readFileSync(app+'/Contents/Resources/app/product.json','utf8'));const buf=fs.readFileSync(zip);const h=a=>c.createHash(a).update(buf).digest('hex');fs.writeFileSync(out,JSON.stringify({url,name:p.version,version:p.commit,productVersion:p.version,hash:h('sha1'),timestamp:String(Date.now()),sha256hash:h('sha256')},null,2)+'\n');console.log(fs.readFileSync(out,'utf8'))" \
  "$APP" "$OUT.zip" "https://github.com/$GH_REPO_PATH/releases/download/v$RELEASE_VERSION/$(basename "$OUT.zip")" ".build/parlay/latest-darwin-${VSCODE_ARCH}.json"
ls -la .build/parlay
echo "== done  $(date)   app: $APP"
