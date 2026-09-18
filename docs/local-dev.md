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
hack/checkout-critic.sh editor/.work
```

reuse an existing `editor/.work` checkout when present. use node 20 and the
checked-in yarn release to install and verify it:

```sh
cd editor/.work
corepack yarn install --immutable
corepack yarn exec mocha test/critic-markup.js test/critic-contexts.js test/critic-footnotes.js test/critic-review-ui.js test/critic-margin.js test/critic-suggestion.js
corepack yarn eslint
corepack yarn mocha-suite
corepack yarn build
```

commit the tested source changes on `critic`, then from this repository:

```sh
hack/sync-critic.sh editor/.work
git -C editor/.work bundle create ../critic.bundle "$(cat editor/UPSTREAM)..critic"
git -C editor/.work bundle verify ../critic.bundle
```

commit the bundle and synchronized board parser files together. `editor/.work`
is gitignored; the bundle carries its commits. `editor/rebase.sh` is for
[upstream upgrades](release.md), and can reset unfinished work.

for browser checks, test wide view (at least 993 pixels), split mode and a
narrow viewport. enter multiline comments, follow line links, move the editor
caret between commented lines, and grow/shrink replies in crowded margins.
check expanded groups and a remote re-render while a reply has a selection in
the middle. accept/reject inline-code suggestions, undo them, and verify
locked/read-only notes, stale previews and published output.

## working on the board

`spec-board/` is a plain node service, so the fast loop is outside compose:

```sh
cd spec-board && npm ci
PGHOST=localhost PGUSER=specdoc PGPASSWORD=specdoc PGDATABASE=specdoc \
  HEDGEDOC_BASE_URL=http://localhost:3000 node server.js
```

`node spec-board/test.js` covers the pure logic and needs no database.

the feedback suites also use provider and model fixtures:

```sh
node spec-board/feedback-github-test.js
node spec-board/feedback-test.js
node spec-board/feedback-service-test.js
```

the persistence suite needs a separate postgres database. it creates a random
schema inside that database and drops only its own schema after the test:

```sh
podman run --rm -d --name specdoc-feedback-test \
  -e POSTGRES_PASSWORD=feedback-test -e POSTGRES_DB=feedback_test \
  -p 127.0.0.1:55432:5432 docker.io/library/postgres:16-alpine
podman exec specdoc-feedback-test pg_isready -U postgres
FEEDBACK_TEST_DATABASE_URL=postgresql://postgres:feedback-test@127.0.0.1:55432/feedback_test \
  node spec-board/feedback-db-test.js
podman stop specdoc-feedback-test
```

wait for `pg_isready` to report that connections are accepted before running
the suite. it checks replay, concurrent decisions, migration reruns, settings
changes during analysis and decision retention.

## working on the mcp server

`mcp/` needs a git checkout to index and a board to read, nothing else.
against the compose stack:

```sh
cd mcp && npm ci && node test.js
cd /some/rust/checkout && SPECDOC_URL=http://localhost:8080 node /path/to/specdoc/mcp/server.js brief
```

`npx @modelcontextprotocol/inspector node /path/to/specdoc/mcp/server.js`
opens a browser ui to call the tools by hand. the test builds its own
throwaway repo and fake board, so it runs anywhere.

## what does not work locally

- github login (the editor falls back to anonymous editing)
- opening spec PRs, unless you put a token in `.env` and name a repo you can
  write to in `NAMESPACES`
- email digests and review bots, unless you point them at real endpoints
