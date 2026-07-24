#!/usr/bin/env bash
# Build the SpecDoc editor image from editor/UPSTREAM + editor/critic.bundle.
# The source snapshot is cached as its own image, so repeat builds only redo the
# overlay and webpack.
#
#   hack/build-editor.sh [IMAGE_TAG]
#
# BUILDER=buildah  use buildah instead of podman (rootless overlay failures)
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
TAG=$(cat "$HERE/editor/UPSTREAM")
IMAGE=${1:-specdoc-editor:$TAG}
SRC_IMAGE=specdoc-editor-src:$TAG
BUILDER=${BUILDER:-podman}
build() { if [ "$BUILDER" = buildah ]; then buildah bud "$@"; else "$BUILDER" build "$@"; fi; }

if ! "$BUILDER" inspect --type image "$SRC_IMAGE" >/dev/null 2>&1; then
  echo ">> building $SRC_IMAGE (full upstream clone + yarn install, several minutes)"
  build -f "$HERE/editor/Containerfile.src" -t "$SRC_IMAGE" "$HERE/editor"
else
  echo ">> reusing $SRC_IMAGE (delete it after changing UPSTREAM or critic.bundle)"
fi

echo ">> building $IMAGE"
build -f "$HERE/editor/Containerfile" --build-arg "SRC=$SRC_IMAGE" -t "$IMAGE" "$HERE/editor"
# compose.yaml defaults to :local so it never carries a version to keep in sync
"$BUILDER" tag "$IMAGE" specdoc-editor:local
echo "built $IMAGE (also tagged specdoc-editor:local)"
