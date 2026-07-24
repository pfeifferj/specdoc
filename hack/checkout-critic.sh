#!/usr/bin/env bash
# Materialize the editor's source tree: upstream at editor/UPSTREAM with the
# fork commits from editor/critic.bundle on top. Same steps the image build
# runs, minus the dependency install.
#
#   hack/checkout-critic.sh DIR
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
DIR=${1:?usage: checkout-critic.sh DIR}
TAG=$(cat "$HERE/editor/UPSTREAM")
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/hedgedoc/hedgedoc.git}

# Not a shallow clone: the bundle is a thin pack whose deltas resolve against
# objects reachable from the base tag's ancestors.
git clone -q --single-branch --no-tags --branch "$TAG" "$UPSTREAM_REPO" "$DIR"
base=$(git -C "$DIR" rev-parse HEAD)
git -C "$DIR" fetch -q "$HERE/editor/critic.bundle" critic:critic
git -C "$DIR" checkout -q critic
git -C "$DIR" merge-base --is-ancestor "$base" critic || {
  echo "!! critic.bundle is not based on $TAG (editor/UPSTREAM); refresh one or the other" >&2
  exit 1
}
echo "critic at $(git -C "$DIR" rev-parse --short critic) on upstream $TAG in $DIR"
