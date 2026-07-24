# local development

everything runs on one machine: no cluster and no github app.

```sh
hack/build-editor.sh        # first run pulls upstream and installs deps: slow
cp .env.example .env
podman compose up           # or docker compose
```

- editor: <http://localhost:3000> (anonymous editing is on)
- board: <http://localhost:8080>

both talk to the compose postgres. state lives in named volumes, so
`podman compose down` keeps your notes and `podman compose down -v` throws them
away.

## what the first build does

`hack/build-editor.sh` builds two images:

1. `specdoc-editor-src:<tag>`: upstream hedgedoc cloned at the tag in
   `editor/UPSTREAM`, with the fork's commits fetched from
   `editor/critic.bundle` on top, plus `yarn install`. a full clone and a full
   dependency install, cached as its own image: it only needs rebuilding when
   `UPSTREAM` or `critic.bundle` changes. delete the image to force it.
2. `specdoc-editor:<tag>`: the rebrand overlay and the webpack build on top.
   this is what rebuilds while you work, in minutes rather than tens of
   minutes.

`BUILDER=buildah hack/build-editor.sh` if rootless podman fails to mount an
overlay over the build context.

## working on the editor

the fork's source is not in this repo: it lives on the `critic` branch inside
`editor/critic.bundle`. to get a working tree:

```sh
./editor/rebase.sh "$(cat editor/UPSTREAM)"   # checkout in editor/.work, branch critic
```

pass the current tag: bare `./editor/rebase.sh` replays onto the newest upstream
release, which is a bump, not what you want mid-change ([releases](release.md)).

commit your change in that checkout, run the same command again to refresh the
bundle, and commit the new `editor/critic.bundle` here. it warns that the
previous dependency-lock commit is now buried under yours; that is expected, and
it regenerates one on top. `editor/.work` is gitignored, so the bundle is the
only copy that leaves your machine.

to read the fork's tree without a rebase or a dependency install:
`hack/checkout-critic.sh <dir>`.

editor tests and lint run in that checkout: `npx mocha test/critic-markup.js`
and `npm run eslint`.

## working on the board

`spec-board/` is a plain node service, so the fast loop is outside compose:

```sh
cd spec-board && npm ci
PGHOST=localhost PGUSER=specdoc PGPASSWORD=specdoc PGDATABASE=specdoc \
  HEDGEDOC_BASE_URL=http://localhost:3000 node server.js
```

`node spec-board/test.js` covers the pure logic and needs no database.

## what does not work locally

- github login (the editor falls back to anonymous editing)
- opening spec PRs, unless you put a token in `.env` and name a repo you can
  write to in `NAMESPACES`
- email digests and review bots, unless you point them at real endpoints
