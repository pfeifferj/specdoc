#!/usr/bin/env bash
# Rebase the bexelbie CriticMarkup fork onto a current upstream HedgeDoc 1.x ref,
# fix up the package.json/lockfile, and stage a buildable tree.
#
#   ./rebase.sh [UPSTREAM_REF] [WORKDIR]
#
# UPSTREAM_REF  git ref to rebase onto. Default: latest upstream release tag.
# WORKDIR       scratch checkout. Default: ./.work (kept between runs for speed).
#               Must be on a real filesystem, NOT tmpfs, or podman build breaks.
#
# What it does, and why each step exists (learned the hard way):
#   - rebases fork/bex-master onto the target; auto-resolves the only expected
#     clashes (package.json, yarn.lock, .github/workflows) by taking the fork side
#   - rebuilds package.json as UPSTREAM's deps + the fork's added deps, so upstream
#     security bumps aren't reverted and no upstream runtime dep is dropped
#   - regenerates yarn.lock so the Dockerfile's `yarn install --immutable` succeeds
#   - drops the Dockerfile/.dockerignore into the tree, ready to build
set -euo pipefail

UPSTREAM=https://github.com/hedgedoc/hedgedoc.git
FORK=https://github.com/bexelbie/hedgedoc.git
FORK_BRANCH=bex-master
HERE=$(cd "$(dirname "$0")" && pwd)
WORKDIR=${2:-"$HERE/.work"}

if [ ! -d "$WORKDIR/.git" ]; then
  git init -q "$WORKDIR"
  git -C "$WORKDIR" remote add up "$UPSTREAM"
  git -C "$WORKDIR" remote add fork "$FORK"
fi
git() { command git -C "$WORKDIR" "$@"; }

echo ">> fetching upstream + fork"
git fetch -q --tags up
# fork is only needed to bootstrap a fresh workdir; critic is self-sufficient after
git fetch -q fork "$FORK_BRANCH" || echo ">> warn: fork fetch failed (ok when critic exists)"

# 1.x only: upstream 2.x is a different architecture, rebasing onto it would
# silently produce garbage the day a 2.0.0 tag appears
TARGET=${1:-$(git tag --sort=-creatordate | grep -E '^1\.[0-9]+\.[0-9]+$' | head -1)}
echo ">> rebasing onto upstream $TARGET"

git config user.email rebase@local >/dev/null
git config user.name rebase >/dev/null
git rebase --abort 2>/dev/null || true
if git rev-parse -q --verify critic >/dev/null; then
  # critic carries local commits beyond the bexelbie fork and is the source of
  # truth: rebase it, never reset it to the fork. Backup ref guards against a
  # botched rebase; -f discards a prior run's uncommitted package.json/yarn.lock.
  backup="backup/critic-$(date +%Y%m%d-%H%M%S)"
  git branch -f "$backup" critic
  echo ">> previous critic saved as $backup"
  git checkout -qf critic
else
  echo ">> bootstrapping critic from fork/$FORK_BRANCH"
  git checkout -qf -B critic "fork/$FORK_BRANCH"
fi

MB=$(git merge-base critic "$TARGET")
GIT_EDITOR=true git rebase --onto "$TARGET" "$MB" critic >/dev/null 2>&1 || true

# Auto-resolve the expected mechanical conflicts; stop on anything else.
# A stopped step with nothing to continue is a commit that became empty on the
# new base (already upstream): skip it, don't bail mid-rebase.
while [ -d "$WORKDIR/.git/rebase-merge" ] || [ -d "$WORKDIR/.git/rebase-apply" ]; do
  conf=$(git diff --name-only --diff-filter=U || true)
  if [ -z "$conf" ]; then
    GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 \
      || GIT_EDITOR=true git rebase --skip >/dev/null 2>&1 || break
    continue
  fi
  real=$(printf '%s\n' "$conf" | grep -vxE 'package\.json|yarn\.lock|\.github/workflows/.*' || true)
  if [ -n "$real" ]; then
    echo "!! unexpected code conflict, resolve by hand in $WORKDIR then re-run:" >&2
    printf '   %s\n' "$real" >&2
    exit 1
  fi
  while IFS= read -r f; do [ -n "$f" ] && git checkout --theirs -- "$f" && git add -- "$f"; done <<<"$conf"
  GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 \
    || GIT_EDITOR=true git rebase --skip >/dev/null 2>&1 || true
done

# The rebase machinery above swallows exit codes; verify the result instead of
# trusting them. Never stage a half-rebased or un-rebased tree.
if [ -d "$WORKDIR/.git/rebase-merge" ] || [ -d "$WORKDIR/.git/rebase-apply" ]; then
  echo "!! rebase did not complete; inspect $WORKDIR (backup ref: ${backup:-none}) and re-run" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$TARGET" critic; then
  echo "!! critic is not based on $TARGET after rebase; inspect $WORKDIR (backup ref: ${backup:-none})" >&2
  exit 1
fi

echo ">> merging package.json: rebased-tree deps ∪ upstream $TARGET versions"
# Union, not replace. Base is the rebased tree's deps (has everything the code
# needs: upstream's + fork-retained like @hedgedoc/meta-marked + fork-added like
# entities). Upstream's versions win on overlap so security bumps land. A plain
# replace with upstream's deps drops fork deps that upstream itself removed.
tmp=$(mktemp)
git show "$TARGET:package.json" > "$tmp"
jq -s '.[0] + {dependencies: (.[0].dependencies * .[1].dependencies)}' \
  "$WORKDIR/package.json" "$tmp" > "$tmp.m" && mv "$tmp.m" "$WORKDIR/package.json"
rm -f "$tmp"

echo ">> regenerating yarn.lock"
( cd "$WORKDIR" && corepack enable 2>/dev/null || true; rm -f yarn.lock; touch yarn.lock; \
  yarn install --mode=skip-build >/dev/null )

# critic exists only in the scratch .work checkout until pushed to a remote;
# the bundle in the deployment repo is the recoverable copy of its patches.
git bundle create -q "$HERE/critic.bundle" "$TARGET..critic"
echo ">> refreshed critic.bundle ($TARGET..critic); commit it in the deployment repo"

echo ">> staging Dockerfile + .dockerignore + SpecDoc overlay"
cp "$HERE/Dockerfile" "$HERE/.dockerignore" "$HERE/overlay.sh" "$WORKDIR/"
rm -rf "$WORKDIR/branding"
cp -r "$HERE/branding" "$WORKDIR/branding"

cat <<EOF

done. rebased tree: $WORKDIR (on upstream $TARGET)
build it:
  podman build -t specdoc-editor:$TARGET "$WORKDIR"
if podman's rootless context-overlay fails (tmpfs / no kernel overlay), use buildah:
  $HERE/buildah-build.sh "$WORKDIR" specdoc-editor:$TARGET
EOF
