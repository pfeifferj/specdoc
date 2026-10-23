#!/usr/bin/env bash
# Rebase the bundled editor onto HedgeDoc 1.x, then export its source inputs.
# Usage: rebase.sh [--bootstrap-from-fork] [--manifest FILE] [UPSTREAM_REF] [WORKDIR]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/hedgedoc/hedgedoc.git}
FORK_REPO=${FORK_REPO:-https://github.com/bexelbie/hedgedoc.git}
BOOTSTRAP_FROM_FORK=0
MANIFEST=
while [[ ${1:-} == --* ]]; do
  case $1 in
    --bootstrap-from-fork) BOOTSTRAP_FROM_FORK=1; shift ;;
    --manifest) MANIFEST=${2:?--manifest requires a file}; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ $# -le 2 ]] || { printf 'Too many arguments\n' >&2; exit 2; }
REQUESTED_TARGET=${1:-}
WORKDIR=${2:-"$HERE/.work"}
caller_name=$(git config user.name)
caller_email=$(git config user.email)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() { printf '%s\n' "$*" >&2; exit 1; }
release_commit() {
  [[ "$1" =~ ^1\.[0-9]+\.[0-9]+$ ]] || fail 'The upstream ref must be a HedgeDoc 1.x release tag.'
  git rev-parse --verify "refs/tags/$1^{commit}"
}
check_release_ancestry() {
  local current_release current_commit
  current_release=$(cat "$HERE/UPSTREAM")
  current_commit=$(release_commit "$current_release")
  git merge-base --is-ancestor "$current_commit" "$1" || fail "The requested release predates or diverges from $current_release; use its historical source inputs for rollback."
  git merge-base --is-ancestor "$current_commit" critic || fail "The critic branch does not contain the declared release $current_release."
}
if [[ ! -e "$WORKDIR/.git" ]]; then
  if [[ -d "$WORKDIR" ]] && ! (
    shopt -s dotglob nullglob
    entries=("$WORKDIR"/*)
    [[ ${#entries[@]} == 0 ]]
  ); then
    fail "Refusing to initialize a nonempty directory: $WORKDIR"
  fi
  git init -q "$WORKDIR"
fi
git() { command git -C "$WORKDIR" "$@"; }
state=$(git rev-parse --path-format=absolute --git-path specdoc-rebase)
if [[ -d $(git rev-parse --path-format=absolute --git-path rebase-merge) || -d $(git rev-parse --path-format=absolute --git-path rebase-apply) ]]; then
  fail "A rebase is in progress in $WORKDIR. Resolve and complete it there, then rerun this command."
fi

if [[ -d "$state" ]]; then
  [[ $BOOTSTRAP_FROM_FORK == 0 ]] || fail 'Cannot bootstrap during an existing update.'
  TARGET=$(cat "$state/target-ref")
  target_commit=$(cat "$state/target")
  source_commit=$(cat "$state/source")
  base_commit=$(cat "$state/base")
  [[ $(release_commit "$TARGET") == "$target_commit" ]] || fail "The saved release tag changed; inspect $state before continuing."
  if [[ -n "$REQUESTED_TARGET" ]]; then
    requested_commit=$(release_commit "$REQUESTED_TARGET")
    [[ "$requested_commit" == "$target_commit" ]] || fail "An update to $TARGET is pending; finish it first."
  fi
  [[ $(git branch --show-current) == critic ]] || fail 'Return to the critic branch before resuming.'
  check_release_ancestry "$target_commit"
  git merge-base --is-ancestor "$target_commit" critic || fail "The saved rebase did not complete. Inspect $WORKDIR and $(cat "$state/backup")."
else
  [[ -z $(git status --porcelain) ]] || fail "Uncommitted changes in $WORKDIR; preserve them before rebasing."
  if ! git remote get-url up >/dev/null 2>&1; then
    git remote add up "$UPSTREAM_REPO"
  fi
  git fetch --tags up
  TARGET=$REQUESTED_TARGET
  if [[ -z "$TARGET" ]]; then
    git tag --list '1.*' --sort=-version:refname > "$tmp/tags"
    while IFS= read -r tag; do
      if [[ "$tag" =~ ^1\.[0-9]+\.[0-9]+$ ]]; then TARGET=$tag; break; fi
    done < "$tmp/tags"
  fi
  [[ -n "$TARGET" ]] || fail 'No upstream 1.x release found.'
  target_commit=$(release_commit "$TARGET")
  git show "$target_commit:package.json" > "$tmp/target.json"
  node "$HERE/rebase-manifest.cjs" --check "$tmp/target.json"
  git config user.name "$caller_name"
  git config user.email "$caller_email"

  if ! git rev-parse -q --verify critic >/dev/null; then
    if [[ $BOOTSTRAP_FROM_FORK == 1 ]]; then
      git fetch "$FORK_REPO" bex-master
      git branch critic FETCH_HEAD
    else
      git fetch "$HERE/critic.bundle" critic:critic
    fi
  elif [[ $BOOTSTRAP_FROM_FORK == 1 ]]; then
    fail '--bootstrap-from-fork requires a fresh checkout; the current critic branch was preserved.'
  fi
  check_release_ancestry "$target_commit"
  source_commit=$(git rev-parse critic)
  base_commit=$(git merge-base critic "$target_commit")
  git log --format=%H --grep '^Specdoc-Lock:' "$base_commit..$source_commit" > "$tmp/locks"
  while IFS= read -r lock; do
    git show --format=%B --no-patch "$lock" | command git interpret-trailers --parse > "$tmp/trailers"
    git diff-tree --no-commit-id --name-only -r "$lock" > "$tmp/paths"
    node "$HERE/rebase-manifest.cjs" --check-lock "$tmp/trailers" "$tmp/paths"
  done < "$tmp/locks"
  backup="backup/critic-$(date +%Y%m%d-%H%M%S)-$$"
  git branch "$backup" "$source_commit"
  mkdir "$state"
  printf '%s\n' "$TARGET" > "$state/target-ref"
  printf '%s\n' "$target_commit" > "$state/target"
  printf '%s\n' "$source_commit" > "$state/source"
  printf '%s\n' "$base_commit" > "$state/base"
  printf '%s\n' "$backup" > "$state/backup"
  cp "$tmp/locks" "$state/locks"
  git checkout -q critic
  printf -v sequence_editor '%q ' node "$HERE/rebase-manifest.cjs" --drop-locks "$state/locks"
  if ! GIT_SEQUENCE_EDITOR="$sequence_editor" git rebase --interactive --reapply-cherry-picks --empty=stop --onto "$target_commit" "$base_commit" critic; then
    fail "Replay stopped. Resolve and complete the rebase in $WORKDIR, then rerun. Backup: $backup"
  fi
fi

git merge-base --is-ancestor "$target_commit" critic || fail 'The target is not an ancestor of critic.'
if [[ -n $(git status --porcelain) ]]; then
  [[ -n "$MANIFEST" ]] || fail 'Preserve pending manifest edits with --manifest FILE before resuming.'
  [[ -z $(git status --porcelain -- . ':(exclude)package.json' ':(exclude)yarn.lock') ]] || fail 'Uncommitted source changes must be committed before export.'
fi
git show "$base_commit:package.json" > "$tmp/base.json"
git show "$source_commit:package.json" > "$tmp/fork.json"
git show "$target_commit:package.json" > "$tmp/target.json"
if [[ -n "$MANIFEST" ]]; then
  cp "$MANIFEST" "$tmp/manifest.json"
  node "$HERE/rebase-manifest.cjs" --check "$tmp/manifest.json" "$tmp/target.json" "$tmp/fork.json"
else
  if ! node "$HERE/rebase-manifest.cjs" "$tmp/base.json" "$tmp/fork.json" "$tmp/target.json" "$tmp/manifest.json"; then
    fail 'Resolve package.json explicitly, then rerun with --manifest FILE. The checkout was preserved.'
  fi
fi
cp "$tmp/manifest.json" "$WORKDIR/package.json"
git show "$target_commit:yarn.lock" > "$WORKDIR/yarn.lock"
(
  cd "$WORKDIR"
  YARN_ENABLE_IMMUTABLE_INSTALLS=false corepack yarn install --mode=skip-build
)
git add -- package.json yarn.lock
if ! git diff --cached --quiet; then
  git commit -s -m "chore(deps): lock for $TARGET" -m "Specdoc-Lock: $TARGET"
fi
[[ -z $(git status --porcelain) ]] || fail 'The checkout is not clean; source inputs were not exported.'
git bundle create "$tmp/critic.bundle" "$target_commit..critic"
git bundle verify "$tmp/critic.bundle"
cp "$tmp/critic.bundle" "$HERE/critic.bundle"
printf '%s\n' "$TARGET" > "$HERE/UPSTREAM"
rm -rf "$state"
printf 'Updated critic.bundle and UPSTREAM for %s. Build with %s/../hack/build-editor.sh\n' "$TARGET" "$HERE"
