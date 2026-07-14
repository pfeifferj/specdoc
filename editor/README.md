# editor

container image of hedgedoc 1.x with inline commenting, from the
[bexelbie criticmarkup fork](https://github.com/bexelbie/hedgedoc) rebased
onto current upstream. drop-in for the official `hedgedoc/hedgedoc` image:
same `CMD_*` env config, port 3000, postgres-ready.

## why a rebase

the fork adds inline comments (criticmarkup `{>> ... <<}`, google-docs-style
margin bubbles), WCAG author colours, and persistent guest identities, but
it's a personal fork that lags upstream and gets no security backports.
running a stale fork of a web app that handles auth is how you end up in a
postmortem. `rebase.sh` replays its ~16 feature commits onto the latest
upstream release each rebuild, so you stay current on upstream's
auth/sanitiser fixes.

## usage

```sh
./rebase.sh                 # rebase onto latest upstream release tag
./rebase.sh 1.11.0          # or onto a specific ref
podman build -t specdoc-editor:latest .work
```

`rebase.sh` keeps a persistent checkout in `.work/`; its `critic` branch is
the source of truth (the fork's commits plus local work: spec plumbing,
suggestion mode). each run rebases `critic` onto the target release (saving
a `backup/critic-<ts>` ref first), fixes `package.json`, regenerates
`yarn.lock`, and copies the Dockerfile in. the bexelbie fork is only fetched
to bootstrap a fresh `.work/`. if `podman build` hits a rootless overlay
error, use `./buildah-build.sh .work specdoc-editor:latest`.

`critic.bundle` is the recoverable copy of every commit on `critic` since
the upstream base tag; rebase.sh refreshes it each run (commit the new
bundle). restore a lost `.work/`:

```sh
git init .work && cd .work
git remote add up https://github.com/hedgedoc/hedgedoc.git
git fetch --tags up
git fetch ../critic.bundle critic:critic && git checkout critic
```

then point your deployment's image at the tag you built.

## notes

- node is pinned to 20; sequelize 5 crashes on node 26's hardened
  `url.parse`.
- the rebase is clean; only `package.json`/`yarn.lock`/CI files clash, and
  those resolve automatically.
- the comment feature is markup annotation, not threaded discussions.
