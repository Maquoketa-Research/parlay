#!/usr/bin/env bash
# Build the Selene VS Code extension from source into a .vsix (it is not published on Open VSX).
#   bash tools/selene-vsix.sh <output-dir>       -> <output-dir>/selene-vscode-1.5.1.vsix
set -euo pipefail
OUT="${1:-.}"; mkdir -p "$OUT"
WORK="$(mktemp -d)"
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/Kampfkarren/selene.git "$WORK/selene"
git -C "$WORK/selene" sparse-checkout set selene-vscode >/dev/null
cd "$WORK/selene/selene-vscode"
npm install --no-audit --no-fund --loglevel=error
npm run -s compile
VERSION="$(node -p "require('./package.json').version")"
npx --yes @vscode/vsce package --allow-missing-repository --skip-license -o "$OUT/selene-vscode-$VERSION.vsix" >/dev/null
ls -la "$OUT/selene-vscode-$VERSION.vsix"
