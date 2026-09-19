#!/usr/bin/env bash
# Authenticode-sign Parlay's Windows binaries from Git Bash. A thin wrapper: sign.ps1 next to this file holds the
# logic (signtool lookup, the three credential modes, SHA-256, RFC 3161 timestamp). README "Signing" has the
# environment contract; with no PARLAY_SIGN_* credential set this prints one line and exits 0.
#
#   bash build/parlay/sign.sh <file or folder>...      sign (a folder: every *.exe, *.dll, *.node under it)
#   bash build/parlay/sign.sh --verify <file>...       signtool verify /pa /v
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
args=()
for a in "$@"; do case "$a" in --verify) args+=(-Verify) ;; *) args+=("$(cygpath -aw "$a")") ;; esac; done
MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -aw "$HERE/sign.ps1")" "${args[@]}"
