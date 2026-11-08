# spec-board

kanban board + automation for hedgedoc spec notes. groups notes tagged `spec`
by status, and on approval opens a PR in the spec's namespace repo. owns its
`spec_board_*` tables in a schema of its own and reads hedgedoc's `Notes`,
`Authors` and four `Users` columns. note writes go through the editor's signed
mutation API, and one database function stores verified email addresses; the
runtime role cannot read oauth tokens or update editor rows directly. schema
changes run first, as a separate migration role: `node server.js --migrate`.

## namespaces

a namespace is a target spec repo (`owner/repo`); every spec belongs to one
via `namespace: owner/repo` frontmatter (default: `DEFAULT_NAMESPACE`). the
allowlist is operator-controlled: only repos in the `NAMESPACES` env are
honored.

onboarding steps and the `.specs/roles.yml` schema:
[docs/onboarding.md](../docs/onboarding.md). the full note-to-PR flow:
[docs/spec-lifecycle.md](../docs/spec-lifecycle.md).

## config

every env var with its default: [docs/configuration.md](../docs/configuration.md).

spec corpora are frozen at `/checkpoints`, one git tag per reconciled state;
the accounts in `BOARD_ADMIN_IDS` cut them. what a checkpoint gates on:
[docs/spec-checkpoints.md](../docs/spec-checkpoints.md).

review bots live in the database rather than the environment: one
`spec_board_bots` row each, managed at `/bots` by the same accounts. a row is
a name, an openai-compatible endpoint URL, a model, an optional API key
(encrypted with `SPECDOC_SECRET_KEY`), a prompt, model request settings, the namespaces it reviews,
and an enabled flag. a row can also carry the sha256 of a bot token for
`/api/bot/notes`, the write api the mcp's tools use; a row with no endpoint is
token-only and never reviews from the poller.

moderation, abuse limits and upgrade steps:
[docs/security.md](../docs/security.md).

## privacy

`privacyPage` (`/privacy`) is the data-handling notice. any change that stores,
sends, or publishes user data must update it in the same commit.

## test

`node test.js` covers the pure logic (parsing, approval quorum, areas,
prefix, numbering, implements-refs, the spec map, the checkpoint gate).

implementation feedback has separate provider, model/ui, service and postgres
suites; commands and the isolated database setup are in
[local development](../docs/local-dev.md). a namespace's `feedback-bot`
selects its model; the settings toggle pauses automatic proposals while keeping
the inbox and decisions.
