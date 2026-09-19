#!/usr/bin/env bash
# The Roblox tooling that ships built in: luau-lsp and StyLua from Open VSX, Selene built from source (it is
# not on Open VSX). Each lands in build/builtin/<name>.vsix, where product.json's builtInExtensions point;
# the build verifies each file's sha256 against product.json, so the Selene hash (a fresh build every
# time) is stamped into the working copy here. Downloads are cached in BUILTIN_CACHE (default .build/builtin-cache).
# luau-lsp carries its server binary inside the vsix, so its target follows the build: VSIX_TARGET is win32-x64
# (default), darwin-arm64 or darwin-x64 (build-darwin.sh sets it). StyLua and Selene are platform-independent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
CACHE="${BUILTIN_CACHE:-$ROOT/.build/builtin-cache}"
TARGET="${VSIX_TARGET:-win32-x64}"
mkdir -p build/builtin "$CACHE"

fetch() { [[ -f "$2" ]] || curl -sSL --fail -o "$2" "$1"; }
fetch "https://open-vsx.org/api/JohnnyMorganz/luau-lsp/$TARGET/1.69.0/file/JohnnyMorganz.luau-lsp-1.69.0@$TARGET.vsix" "$CACHE/luau-lsp-1.69.0-$TARGET.vsix"
fetch "https://open-vsx.org/api/JohnnyMorganz/stylua/1.7.2/file/JohnnyMorganz.stylua-1.7.2.vsix" "$CACHE/stylua-1.7.2.vsix"
[[ -f "$CACHE/selene-vscode-1.5.1.vsix" ]] || bash build/parlay/selene-vsix.sh "$CACHE"
cp "$CACHE/luau-lsp-1.69.0-$TARGET.vsix" build/builtin/luau-lsp.vsix
cp "$CACHE/stylua-1.7.2.vsix" build/builtin/stylua.vsix
cp "$CACHE/selene-vscode-1.5.1.vsix" build/builtin/selene.vsix

node - <<'EOF'
const fs = require("fs"), crypto = require("crypto");
const product = JSON.parse(fs.readFileSync("product.json", "utf8"));
for (const ext of product.builtInExtensions) {
	if (!ext.vsix) continue;
	ext.sha256 = crypto.createHash("sha256").update(fs.readFileSync(ext.vsix)).digest("hex");
	console.log(`${ext.name}  ${ext.vsix}  ${ext.sha256.slice(0, 12)}`);
}
fs.writeFileSync("product.json", JSON.stringify(product, null, "\t") + "\n");
EOF
