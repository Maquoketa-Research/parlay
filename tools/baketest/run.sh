#!/usr/bin/env bash
# Smoke test for the Meshy paint bake (src/meshy.ts webview): renders a torus knot from the six cameras, feeds a
# tinted sheet back as the "paint", bakes it onto the UVs, exports the GLB, reloads it and checks that the front
# reads cell 0's tint and the back cell 2's. Needs Edge (headless, software WebGL) and Python 3.
#   bash tools/baketest/run.sh            -> prints out/result.json, exit 0 when ok
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDE="$(cd "$HERE/../.." && pwd)"
EDGE="${EDGE:-/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe}"
PORT=8123

[[ -d "$IDE/media/three" ]] || (cd "$IDE" && node tools/vendor-three.mjs)
rm -rf "$HERE/three" "$HERE/out"; cp -r "$IDE/media/three" "$HERE/three"; mkdir -p "$HERE/out"
python "$HERE/make_test.py"
python "$HERE/server.py" "$PORT" & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/test.html" >/dev/null 2>&1 && break; sleep 0.25; done
timeout 90 "$EDGE" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --no-first-run --disable-extensions \
  --user-data-dir="$HERE/edge-profile" "http://127.0.0.1:$PORT/test.html" 2>/dev/null || true
cat "$HERE/out/result.json" 2>/dev/null || { echo "no result: the page never finished (see out/)"; exit 1; }
echo
grep -q '"ok": true' "$HERE/out/result.json"
