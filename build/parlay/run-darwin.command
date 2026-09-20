#!/usr/bin/env bash
# Open the prepared local Mac build. Double-click in Finder, or pass a folder from a terminal.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != Darwin ]]; then
	echo "This launcher is for macOS."
	exit 1
fi

# A repo-local Node install also works when Finder starts with a minimal PATH.
NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"
ARCH="$(uname -m)"
[[ "$ARCH" == x86_64 ]] && ARCH=x64
LOCAL_NODE="$ROOT/.build/toolchains/node-v${NODE_VERSION}-darwin-${ARCH}/bin"
export PATH="$LOCAL_NODE:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
	echo "Node $NODE_VERSION is required to run the local build."
	exit 1
fi

APP_NAME="$(node -p "require('./product.json').nameLong")"
if [[ ! -d ".build/electron/$APP_NAME.app" || ! -f out/main.js || ! -f extensions/parlay/out/extension.js ]]; then
	echo "Prepare the local app and extensions first; see build/parlay/README.md (Local Mac development)."
	exit 1
fi

unset ELECTRON_RUN_AS_NODE
export VSCODE_SKIP_PRELAUNCH=1
PROFILE="$ROOT/.build/parlay-local"
exec bash scripts/code.sh --user-data-dir "$PROFILE" --extensions-dir "$PROFILE/extensions" --shared-data-dir "$PROFILE/shared-data" "$@"
