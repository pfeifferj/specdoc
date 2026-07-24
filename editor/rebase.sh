#!/usr/bin/env bash
# Rebase the bexelbie CriticMarkup fork onto a current upstream HedgeDoc 1.x ref,
# fix up the package.json/lockfile, and stage a buildable tree.
#
#   ./rebase.sh [--bootstrap-from-fork] [UPSTREAM_REF] [WORKDIR]
#
# UPSTREAM_REF  git ref to rebase onto. Default: latest upstream release tag.
# WORKDIR       scratch checkout. Default: ./.work (kept between runs for speed).
#               Must be on a real filesystem, NOT tmpfs, or podman build breaks.
#
# This is a maintenance tool, not a build step: images build from critic.bundle
# + UPSTREAM via editor/Containerfile.src, with no rebase involved.
#
# What it does, and why each step exists (learned the hard way):
#   - rebases critic onto the target; auto-resolves the only expected clashes
#     (package.json, yarn.lock, .github/workflows) by taking the critic side
#   - rebuilds package.json as UPSTREAM's deps + the fork's added deps, so upstream
#     security bumps aren't reverted and no upstream runtime dep is dropped
#   - regenerates yarn.lock, then commits both onto critic so the bundle carries a
#     manifest that actually installs; without that commit the branch's package.json
#     is whatever the conflict resolution kept, which is missing upstream's deps
#   - refreshes critic.bundle and UPSTREAM, the two inputs an image build needs
set -euo pipefail

UPSTREAM=https://github.com/hedgedoc/hedgedoc.git
FORK=https://github.com/bexelbie/hedgedoc.git
FORK_BRANCH=bex-master
BOOTSTRAP_FROM_FORK=0
if [ "${1:-}" = "--bootstrap-from-fork" ]; then
  BOOTSTRAP_FROM_FORK=1
  shift
fi
HERE=$(cd "$(dirname "$0")" && pwd)
WORKDIR=${2:-"$HERE/.work"}
LOCK_TRAILER=Specdoc-Lock

if [ ! -d "$WORKDIR/.git" ]; then
  git init -q "$WORKDIR"
  git -C "$WORKDIR" remote add up "$UPSTREAM"
fi
git() { command git -C "$WORKDIR" "$@"; }

echo ">> fetching upstream"
git fetch -q --tags up

# 1.x only: upstream 2.x is a different architecture, rebasing onto it would
# silently produce garbage the day a 2.0.0 tag appears
TARGET=${1:-$(git tag --sort=-creatordate | grep -E '^1\.[0-9]+\.[0-9]+$' | head -1)}
echo ">> rebasing onto upstream $TARGET"

# Inherit the caller's identity: the lock commit lands on critic and upstream's
# commit-msg hook rejects a placeholder address.
git config user.email "$(command git config user.email)" >/dev/null
git config user.name "$(command git config user.name)" >/dev/null
git rebase --abort 2>/dev/null || true
if ! git rev-parse -q --verify critic >/dev/null; then
  # A fresh workdir must be seeded from the bundle: it is the only copy of the
  # local commits. Seeding from the fork instead silently drops all of them.
  if [ "$BOOTSTRAP_FROM_FORK" = 1 ]; then
    echo ">> bootstrapping critic from fork/$FORK_BRANCH (bundle ignored)"
    git remote add fork "$FORK" 2>/dev/null || true
    git fetch -q fork "$FORK_BRANCH"
    git branch -q critic "fork/$FORK_BRANCH"
  else
    echo ">> bootstrapping critic from critic.bundle"
    git fetch -q "$HERE/critic.bundle" critic:critic
  fi
fi
# critic is the source of truth: rebase it, never reset it. Backup ref guards
# against a botched rebase; -f discards any stray worktree edits.
backup="backup/critic-$(date +%Y%m%d-%H%M%S)"
git branch -f "$backup" critic
echo ">> previous critic saved as $backup"
git checkout -qf critic

# The lock commit is regenerated below for the new target. Left in place it wins
# the package.json conflict resolution and pins the old target's dependencies.
while git log -1 --format=%B critic | grep -q "^$LOCK_TRAILER:"; do
  echo ">> dropping the previous lock commit"
  git reset -q --hard HEAD~1
done
buried=$(git log --format=%H --grep "^$LOCK_TRAILER:" "$TARGET..critic" | wc -l)
[ "$buried" = 0 ] || echo "!! warn: $buried lock commit(s) under later work; drop them by hand" >&2

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
trap 'rm -f "$tmp" "$tmp.m"' EXIT
git show "$TARGET:package.json" > "$tmp"
jq -s '.[0] + {dependencies: (.[0].dependencies * .[1].dependencies)}' \
  "$WORKDIR/package.json" "$tmp" > "$tmp.m" && mv "$tmp.m" "$WORKDIR/package.json"

echo ">> regenerating yarn.lock"
(
  cd "$WORKDIR" || exit 1
  corepack enable 2>/dev/null || true
  rm -f yarn.lock
  touch yarn.lock
  yarn install --mode=skip-build >/dev/null
)

# Commit the merged manifest: an image build gets the tree from the bundle alone,
# so a manifest living only in this worktree is unbuildable everywhere else.
git add -- package.json yarn.lock
if git diff --cached --quiet; then
  echo ">> manifest unchanged, no lock commit"
else
  git commit -q -m "chore(deps): lock for $TARGET" -m "$LOCK_TRAILER: $TARGET"
  echo ">> committed the merged package.json + yarn.lock"
fi

# critic exists only in the scratch .work checkout until pushed to a remote;
# the bundle in the deployment repo is the recoverable copy of its patches, and
# together with UPSTREAM it is the whole input to an image build.
git bundle create -q "$HERE/critic.bundle" "$TARGET..critic"
echo "$TARGET" > "$HERE/UPSTREAM"
echo ">> refreshed critic.bundle ($TARGET..critic) and UPSTREAM; commit both"

cat <<EOF

done. rebased tree: $WORKDIR (on upstream $TARGET)
build the image from the repo (not from $WORKDIR):
  $HERE/../hack/build-editor.sh
EOF
