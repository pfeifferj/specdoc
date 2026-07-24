# editor

container image of hedgedoc 1.x with criticmarkup review: inline comment
threads with replies, suggestions with accept/reject, spec approvals in the
navbar. drop-in for the official `hedgedoc/hedgedoc` image: same `CMD_*` env
config, port 3000, postgres-ready.

## why it rebases

the review features start from the
[bexelbie criticmarkup fork](https://github.com/bexelbie/hedgedoc), a personal
fork that lags upstream and gets no security backports. running a stale fork
of a web app that handles auth is how you end up in a postmortem, so the
commits are carried as a rebasable series instead of a snapshot, and the two
files it produces are the whole build input:

- `UPSTREAM`: the upstream release tag the series sits on.
- `critic.bundle`: a git bundle of every commit above that tag.

`Containerfile.src` clones upstream at that tag, fetches the bundle, and
installs dependencies; `Containerfile` applies the rebrand overlay and builds.
`BUILDER=buildah` on hosts where rootless podman cannot mount an overlay over
the context. builds never rebase; `rebase.sh` is a maintenance step run by
hand ([releases and rebases](../docs/release.md)).

## recovering a lost .work checkout

`critic.bundle` is the only copy of the fork's commits that leaves your
machine, so the working tree is reconstructible from this repo alone:

```sh
git init .work && cd .work
git remote add up https://github.com/hedgedoc/hedgedoc.git
git fetch --tags up
git fetch ../critic.bundle critic:critic && git checkout critic
```

`../hack/checkout-critic.sh <dir>` does the same without the dependency
install.

## notes

- node is pinned to 20; sequelize 5 crashes on node 26's hardened `url.parse`.
- the patch ledger is `FORK.md` on the `critic` branch, not in this tree.
