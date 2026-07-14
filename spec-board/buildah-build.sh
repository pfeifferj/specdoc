#!/usr/bin/env bash
# Fallback builder for when `podman build` fails with
#   "mounting an overlay over build context directory ... no such device"
# (rootless overlay unavailable). Uses buildah from/copy/run/commit instead.
# On a normal host, just: podman build -t spec-board:local .
#
#   ./buildah-build.sh [IMAGE_TAG]
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=${1:-spec-board:local}

builder=$(buildah from docker.io/library/node:20-alpine)
buildah config --workingdir /app "$builder"
buildah copy "$builder" package.json package-lock.json /app/
buildah run "$builder" -- sh -c 'cd /app && npm ci --omit=dev'
buildah copy "$builder" server.js favicon.ico favicon-32x32.png favicon-16x16.png apple-touch-icon.png /app/
buildah copy "$builder" fonts /app/fonts
buildah config \
  --workingdir /app --env NODE_ENV=production \
  --port 8080 --user node --cmd '["node","server.js"]' "$builder"
buildah commit "$builder" "$IMAGE"
buildah rm "$builder" >/dev/null
echo "built $IMAGE"
