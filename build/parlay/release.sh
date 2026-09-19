#!/usr/bin/env bash
# Publish a built Parlay installer so installed copies pick it up: a GitHub release v<version> carrying the .exe,
# then the manifest the app polls, updates/<quality>/win32/<arch>/<target>/latest.json (the path createUpdateURL
# builds in src/vs/platform/update/electron-main/abstractUpdateService.ts), committed on local main and mirrored
# to GitHub main the usual way (commit-tree onto parlay, push parlay:main).
#
#   bash build/parlay/release.sh                                  newest .build/parlay/ParlayUserSetup-*.exe
#   bash build/parlay/release.sh .build/parlay/ParlayUserSetup-x64-1.135.06215.exe
#   bash build/parlay/release.sh --dry-run [installer]            hashes and manifest only: no gh, no commit, no push
#
# Needs gh (winget install GitHub.cli, then gh auth login), the installer's sidecar .json that build-win32.sh
# writes next to it, and a checkout of local main with nothing staged.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
REPO=Maquoketa-Research/parlay

DRY= EXE=
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) EXE="$a" ;; esac; done
[[ -n "$EXE" ]] || EXE="$(ls -t .build/parlay/ParlayUserSetup-*.exe 2>/dev/null | head -1)"
[[ -f "$EXE" ]] || { echo "!! no installer found; build one: bash build/parlay/build-win32.sh"; exit 1; }
SIDECAR="${EXE%.exe}.json"
[[ -f "$SIDECAR" ]] || { echo "!! $SIDECAR missing; rebuild with the current build-win32.sh, it writes the sidecar"; exit 1; }

# what the installer is: build-win32.sh copied these out of the installer's own product.json
read -r COMMIT VERSION QUALITY TARGET ARCH TIMESTAMP < <(node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log([s.commit,s.productVersion,s.quality,s.target,s.arch,s.timestamp].join(' '))" "$SIDECAR")
[[ "$EXE" == *"-${ARCH}-${VERSION}.exe" ]] || { echo "!! $EXE does not match its sidecar ($ARCH $VERSION)"; exit 1; }
[[ "$(git rev-parse HEAD)" == "$COMMIT" ]] || echo "?? HEAD is $(git rev-parse --short HEAD) but the installer was built from ${COMMIT:0:9}; releasing it anyway"

TAG="v$VERSION"
NAME="$(basename "$EXE")"
URL="https://github.com/$REPO/releases/download/$TAG/$NAME"
MANIFEST="updates/$QUALITY/win32/$ARCH/$TARGET/latest.json"
SHA1="$(sha1sum "$EXE" | cut -d' ' -f1)"
SHA256="$(sha256sum "$EXE" | cut -d' ' -f1)"
echo "== $NAME  $VERSION from ${COMMIT:0:9}"
echo "== sha1 $SHA1  sha256 $SHA256"

if [[ -z "$DRY" ]]; then
  command -v gh >/dev/null || { echo "!! gh is not installed: winget install GitHub.cli, then gh auth login"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "!! gh is not logged in: gh auth login"; exit 1; }
  [[ "$(git symbolic-ref --short HEAD)" == main ]] || { echo "!! release from local main; you are on $(git symbolic-ref --short HEAD)"; exit 1; }
  git diff --cached --quiet || { echo "!! staged changes would ride along in the release commit; commit or unstage them first"; exit 1; }
  git rev-parse -q --verify parlay >/dev/null || { echo "!! no local parlay branch to mirror onto"; exit 1; }

  echo "== GitHub release $TAG"
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
    || gh release create "$TAG" --repo "$REPO" --title "Parlay $VERSION" --notes "Parlay $VERSION, built from ${COMMIT:0:9}. Installed copies update themselves from this release."
  gh release upload "$TAG" "$EXE" --repo "$REPO" --clobber
fi

echo "== $MANIFEST"
mkdir -p "$(dirname "$MANIFEST")"
# VSCodium's versions-repo shape. The client needs url, version (the commit) and productVersion, checks
# sha256hash after downloading, and reads timestamp for update.minReleaseAge; name and hash ride along.
node -e "const [url,name,version,hash,timestamp,sha256hash]=process.argv.slice(1);console.log(JSON.stringify({url,name,version,productVersion:name,hash,timestamp,sha256hash},null,2))" \
  "$URL" "$VERSION" "$COMMIT" "$SHA1" "$TIMESTAMP" "$SHA256" > "$MANIFEST"
cat "$MANIFEST"

# macOS: the tag push above starts .github/workflows/mac.yml, which builds the zip on a hosted Mac and puts its
# manifest on this release as latest-darwin-<arch>.json. Whatever is there (or already in .build/parlay) becomes
# updates/<quality>/darwin/<arch>/latest.json in the same commit; re-run release.sh once the Mac build has finished.
[[ -n "$DRY" ]] || gh release download "$TAG" --repo "$REPO" --pattern 'latest-darwin-*.json' --dir .build/parlay --clobber 2>/dev/null || true
for f in .build/parlay/latest-darwin-*.json; do
  [[ -f "$f" ]] || continue
  DARWIN="updates/$QUALITY/darwin/$(basename "${f%.json}" | sed 's/^latest-darwin-//')/latest.json"
  mkdir -p "$(dirname "$DARWIN")"; cp "$f" "$DARWIN"; echo "== $DARWIN  <- $(basename "$f")"
done

if [[ -n "$DRY" ]]; then
  echo "== dry run: skipped gh release create/upload $TAG and the commit, mirror and push of $MANIFEST"
  exit 0
fi

echo "== commit on main, mirror onto parlay, push as GitHub main"
git add "$MANIFEST"
[[ -d "updates/$QUALITY/darwin" ]] && git add "updates/$QUALITY/darwin"
git diff --cached --quiet && { echo "== nothing new to commit: the manifests already say this"; exit 0; }
git commit -q -m "Release Parlay $VERSION" -m "$URL"
P="$(git commit-tree "HEAD^{tree}" -p parlay -m "$(git log -1 --format=%B HEAD)")"
git branch -f parlay "$P"
git push -q --no-verify origin parlay:main
echo "== done: $URL"
