# releases and rebases

the editor is a fork of hedgedoc 1.x. two files in this repo are its whole
source of truth:

- `editor/UPSTREAM`: the upstream release tag the fork sits on.
- `editor/critic.bundle`: a git bundle of every fork commit on top of that tag.

an image build clones upstream at `UPSTREAM`, fetches the bundle, checks out
`critic`, and asserts the tag really is the bundle's base. those two files are
also what AGPL's corresponding-source obligation points at.

the rebase is a maintenance step; builds never run it.

## bumping upstream

```sh
./editor/rebase.sh              # newest 1.x tag
./editor/rebase.sh 1.12.0       # or a specific one
```

it keeps a checkout in `editor/.work` (gitignored, several hundred MB), rebases
`critic` onto the target, reconciles `package.json`, regenerates `yarn.lock`,
and commits the manifest and lock as a `Specdoc-Lock:` commit before refreshing
`critic.bundle` and `UPSTREAM`. Previous lock commits are excluded from replay.

The target release supplies package metadata, toolchain versions and unchanged
dependencies. Independent fork additions and scripts remain. A dependency patch
is retained only when its underlying version still matches upstream. Conflicting
changes require an explicit resolution rather than silently selecting a version.
Save a reviewed manifest outside the checkout and pass it with
`--manifest /absolute/path/package.json` when rerunning the update.

- The tag scan selects 1.x releases. HedgeDoc 2.x uses a different architecture
  and needs a separate migration.
- The selected release must contain the declared current base. Use historical
  source inputs and images for rollback rather than rebasing onto an older tag.
- A replay conflict stops the script without discarding local work. Resolve and
  complete the Git rebase in `editor/.work`, then rerun the update command. Each
  update saves a backup ref before replaying; a pending update retains that ref.
- a fresh checkout is seeded from `critic.bundle`, never from the upstream fork
  it started as. `--bootstrap-from-fork` seeds the original fork only in a fresh
  checkout and refuses to replace an existing `critic` branch.

then, in this repo:

```sh
git add editor/UPSTREAM editor/critic.bundle
hack/build-editor.sh            # rebuild both images against the new base
```

commit the bundle in the same change as anything else that moved. the fork's
own patch ledger lives in `FORK.md` on the `critic` branch, not here: read it
with `git -C editor/.work show critic:FORK.md`.

## shipping

two images come out of this repo, and how they reach a running system is up to
the deployment. the reference one builds them in-cluster from `master` and
rolls out on an image trigger
([its runbook](https://github.com/pfeifferj/specdoc-infra/blob/master/docs/operations.md)).

cache the source snapshot separately whatever builds them
([local development](local-dev.md) explains why). an editor image built against
a stale one fails the check in `editor/Containerfile` rather than shipping the
wrong source.

Keep a restorable database backup with the previous image before an upgrade.
An image rollback does not reverse schema migrations. HedgeDoc 1.12 removes the
legacy `Temp` table, so returning to an older release may also require restoring
its matching database. Reverting the source commit alone leaves the schema as it
is.
