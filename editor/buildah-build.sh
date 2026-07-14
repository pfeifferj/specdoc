#!/usr/bin/env bash
# Fallback builder for when `podman build` / `docker build` fail with
#   "mounting an overlay over build context directory ... no such device"
# (rootless overlay unavailable: tmpfs context or no kernel overlay module).
# Uses buildah from/copy/run/commit, which goes through the working graph driver
# instead of the broken context-overlay path. Produces the same image the
# Dockerfile would. On a normal host, just use `podman build` and ignore this.
#
#   ./buildah-build.sh [WORKDIR] [IMAGE_TAG]
set -euo pipefail
WORKDIR=${1:-"$(cd "$(dirname "$0")" && pwd)/.work"}
IMAGE=${2:-specdoc-editor:local}
cd "$WORKDIR"

builder=$(buildah from docker.io/library/node:20-bookworm)
buildah run "$builder" -- bash -c 'corepack enable'
buildah config --workingdir /app "$builder"
buildah copy "$builder" .yarnrc.yml package.json yarn.lock /app/
buildah copy "$builder" .yarn/releases /app/.yarn/releases
buildah copy "$builder" .yarn/patches /app/.yarn/patches
buildah run "$builder" -- bash -c 'cd /app && yarn install --immutable'
# buildah copy has no .dockerignore; a host node_modules/build would clobber the
# container's fresh install (and may carry wrong-platform native builds). Drop the
# regenerable dirs first, then copy source over the container's install.
rm -rf node_modules public/build .yarn/cache
buildah copy "$builder" . /app
# Same as the Dockerfile's RUN bash overlay.sh: rebrand + feature-hide must
# land before yarn build so the overlaid views/css get bundled.
buildah run "$builder" -- bash -c 'cd /app && bash overlay.sh'
buildah run "$builder" -- bash -c 'cd /app && yarn build && yarn workspaces focus --production && yarn cache clean'

runtime=$(buildah from docker.io/library/node:20-bookworm-slim)
buildah copy --from="$builder" "$runtime" /app /hedgedoc
buildah run "$runtime" -- bash -c 'cp /hedgedoc/config.json.example /hedgedoc/config.json'
buildah config \
  --workingdir /hedgedoc --env NODE_ENV=production \
  --port 3000 --user node --cmd '["node","app.js"]' "$runtime"
buildah commit "$runtime" "$IMAGE"
buildah rm "$builder" "$runtime" >/dev/null
echo "built $IMAGE"
