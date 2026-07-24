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
./editor/rebase.sh 1.11.1       # or a specific one
```

it keeps a checkout in `editor/.work` (gitignored, several hundred MB), rebases
`critic` onto the target, rebuilds `package.json` as upstream's dependencies
merged with the fork's, regenerates `yarn.lock`, commits both onto `critic` as
a `Specdoc-Lock:` commit, and refreshes `critic.bundle` and `UPSTREAM`.

that lock commit matters: the conflict resolution keeps the fork's side of
`package.json`, so without it the branch carries a manifest that is missing
whatever upstream added since the fork. the next rebase drops the old lock
commit before replaying, so they do not stack.

- 1.x only: the tag scan skips 2.x on purpose, since it is a different
  architecture and rebasing onto it would produce garbage without saying so.
- conflicts outside `package.json`, `yarn.lock` and `.github/workflows` stop
  the script. resolve them by hand in `editor/.work` on branch `critic`, then
  re-run. every run saves a `backup/critic-<timestamp>` ref first.
- a fresh checkout is seeded from `critic.bundle`, never from the upstream fork
  it started as. `--bootstrap-from-fork` exists for the day you want the
  original fork instead, and it discards the local commits.

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

to roll back, deploy the previous image; reverting the commit rebuilds but
leaves the schema where it was.
