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
   `UPSTREAM`, `critic.bundle` or `Containerfile.src` changes, and its tag
   records all three. delete the image to force it.
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

reuse an existing `editor/.work` checkout when present. install and verify it
with the checked-in yarn release on node 24.22.1, which
`editor/Containerfile.src` pins and the fork's `engines` field requires:

```sh
cd editor/.work
corepack yarn install --immutable
corepack yarn exec mocha test/critic-markup.js test/critic-contexts.js test/critic-footnotes.js test/critic-review-ui.js test/critic-margin.js test/critic-suggestion.js test/frontmatter-repair.js
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

`spec-board/` is a plain node service, so the fast loop runs it on the host
against the compose database. compose publishes no postgres port; add one in a
`compose.override.yaml`, which compose merges automatically:

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
```

then start postgres and the editor without the compose board, which would hold
port 8080 and poll the same database (`podman compose stop board` if it runs):

```sh
podman compose up -d postgres editor
cd spec-board && npm ci
NODE_ENV=development SPECDOC_AUTO_MIGRATE=true \
  PGHOST=localhost PGUSER=specdoc_migrate PGPASSWORD=migration-local-only \
  PGDATABASE=specdoc BOARD_DB_RUNTIME_ROLE=specdoc_board \
  EDITOR_DB_ROLE=specdoc_editor node server.js
```

`SPECDOC_AUTO_MIGRATE=true`, accepted only with `NODE_ENV=development`,
migrates at startup and lets the migration role serve. otherwise the board
refuses an unmigrated schema or an over-privileged role; deployments run the
migration as a separate job ([bootstrap](bootstrap.md#4-run-them)).

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

## working on the CLI

The package is self-contained; its remote commands need no checkout index or
native dependency. Build and test the installable artifact:

```sh
cd cli
npm ci
npm test
npm run test:package
```

The package test installs the tarball with optional dependencies omitted,
then exercises the installed executable from an empty directory.
After installing editor dependencies, run the CLI against real editor routes
and an isolated in-memory SQLite database:

```sh
node hack/test-cli-editor.cjs
```

This test approves the rendered consent form through a fixture browser session,
then runs login, raw checkout, guarded updates, receipt recovery after a lost
response, and logout. Provider/session continuation is covered by editor tests.
Set `SPECDOC_TEST_EDITOR_DIR` to test a different reconstructed editor tree.

Receipt and token races also need a disposable PostgreSQL database. With that
database running, use its URL explicitly; each suite creates and drops its own
random schema:

```sh
SPECDOC_TEST_POSTGRES_URL=postgresql://postgres:cli-test@127.0.0.1:55432/cli_test \
  npm --prefix editor/.work run test:cli-postgres
AUDIT_TEST_DATABASE_URL=postgresql://postgres:cli-test@127.0.0.1:55432/cli_test \
  node spec-board/public-operations-db-test.js
AUDIT_TEST_DATABASE_URL=postgresql://postgres:cli-test@127.0.0.1:55432/cli_test \
  node spec-board/bot-api-db-test.js
```

The PostgreSQL upgrade test needs a role with `CREATE DATABASE`:

```sh
SPECDOC_TEST_POSTGRES_URL=postgresql://postgres:cli-test@127.0.0.1:55432/cli_test \
  npm --prefix editor/.work run test:upgrade-postgres
```

CI runs CLI package tests on Node 22 and 24, PostgreSQL race tests, and the
CLI/editor integration test against the exported editor bundle.

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
