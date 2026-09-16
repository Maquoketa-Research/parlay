#!/usr/bin/env bash
# One-time: collapse upstream VS Code's history (163,821 commits, ~1.2 GB packed) into a single
# snapshot commit under the fork's own commits. Every fork commit keeps its tree, message, author
# and dates; only the parent link that pointed into upstream history moves to the snapshot.
#
# Run from any checkout of the fork:   bash build/parlay/squash-upstream.sh [branch]
# The old tip is kept at refs/backup/<branch>-full-history. Nothing is pushed.
# The local .git does not shrink until every other ref (main, origin/*) also drops the old history:
#   git branch -f main <branch>; git push --force origin main <branch>
#   git reflog expire --expire=now --all && git gc --prune=now --aggressive
# or simply re-clone.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BR=${1:-$(git rev-parse --abbrev-ref HEAD)}
# The upstream commit the fork imported ("Import Visual Studio Code 1.135.0" merged it in).
UP=$(git rev-parse 08d4889f9ec)
OLD=$(git rev-parse "$BR")
git update-ref "refs/backup/$BR-full-history" "$OLD"

declare -A MAP
mk() { # mk <orig-commit> <tree> [parents...]   message on stdin; prints the new sha
	local c=$1 tree=$2; shift 2
	local args=() p
	for p in "$@"; do args+=(-p "$p"); done
	GIT_AUTHOR_NAME="$(git log -1 --format=%an "$c")" \
	GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae "$c")" \
	GIT_AUTHOR_DATE="$(git log -1 --format=%ad --date=raw "$c")" \
	GIT_COMMITTER_NAME="$(git log -1 --format=%cn "$c")" \
	GIT_COMMITTER_EMAIL="$(git log -1 --format=%ce "$c")" \
	GIT_COMMITTER_DATE="$(git log -1 --format=%cd --date=raw "$c")" \
	git commit-tree "$tree" "${args[@]}"
}

ROOT=$(printf 'Visual Studio Code 1.135.0\n\nmicrosoft/vscode at %s, squashed to a single commit. The upstream history\nis not carried in this repository; README.md (History) says how to merge a\nnewer upstream on top of this snapshot.\n' "$UP" | mk "$UP" "$UP^{tree}")
MAP[$UP]=$ROOT

n=0
for c in $(git rev-list --reverse --topo-order "$BR" "^$UP"); do
	parents=()
	for p in $(git rev-list --parents -n1 "$c" | cut -d' ' -f2- -s); do
		if [[ -n "${MAP[$p]:-}" ]]; then
			parents+=("${MAP[$p]}")
		else
			echo "commit $c has a parent outside the fork and the import point: $p" >&2
			exit 1
		fi
	done
	new=$(git log -1 --format=%B "$c" | mk "$c" "$c^{tree}" ${parents[@]+"${parents[@]}"})
	MAP[$c]=$new
	n=$((n + 1))
done

NEW=${MAP[$OLD]}
git update-ref "refs/heads/$BR" "$NEW" "$OLD"

echo "rewrote $n fork commits on $BR"
echo "upstream snapshot commit: $ROOT   (stands in for $UP)"
echo "old tip: $OLD   (kept at refs/backup/$BR-full-history)"
echo "new tip: $NEW"
echo "files that differ between old and new tip (must be 0): $(git diff --name-only "$OLD" "$NEW" | wc -l)"
echo "commits reachable from $BR now: $(git rev-list --count "$BR")"
echo
echo "To merge a newer upstream later:"
echo "  git replace $ROOT $UP"
