#!/usr/bin/env bash
# Export the editor's shared CriticMarkup parser to the board.
# Usage: hack/sync-critic.sh [--check] FORK_DIR
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
CHECK=false
if [[ ${1:-} == --check ]]; then
  CHECK=true
  shift
fi
if [[ $# != 1 ]]; then
  echo "usage: sync-critic.sh [--check] FORK_DIR" >&2
  exit 2
fi
FORK_DIR=$1
FILES=(critic-markup.js critic-source.js critic-context-block.js critic-context-inline.js)
for file in "${FILES[@]}"; do
  if [[ ! -f "$FORK_DIR/public/js/lib/$file" ]]; then
    echo "missing editor parser: $FORK_DIR/public/js/lib/$file" >&2
    exit 1
  fi
done

status=0
for file in "${FILES[@]}"; do
  source_file="$FORK_DIR/public/js/lib/$file"
  target_file="$HERE/spec-board/$file"
  if "$CHECK"; then
    if ! cmp -s "$source_file" "$target_file"; then
      echo "stale shared parser: spec-board/$file (run hack/sync-critic.sh FORK_DIR)" >&2
      status=1
    fi
  else
    cp "$source_file" "$target_file"
  fi
done
exit "$status"
