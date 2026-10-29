#!/bin/sh
# Rebuilds static/ from a clean export and compares it with the exported static/.
#   staged: export the index (pre-commit).
#   head:   export HEAD (pre-push).
# A clean export keeps unstaged or uncommitted ui/ edits out of the check.
set -eu

mode=${1:-}
tree=$(mktemp -d)
trap 'rm -rf "$tree"' EXIT

case "$mode" in
  staged)
    git checkout-index --all --prefix="$tree/"
    fix="run bun run build:ui, stage static/, and commit again."
    ;;
  head)
    git archive HEAD | tar -x -C "$tree"
    fix="run bun run build:ui, commit static/, and push again."
    ;;
  *)
    echo "usage: $0 staged|head" >&2
    exit 2
    ;;
esac

cp -R "$tree/static" "$tree/static.expected"
(cd "$tree" && bun ui/scripts/build-ui.ts >/dev/null)

if ! diff -r "$tree/static.expected" "$tree/static" >/dev/null; then
  echo "static/ does not match ui/: $fix" >&2
  exit 1
fi
