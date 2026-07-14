# spec-board

kanban board + automation for hedgedoc spec notes. groups notes tagged `spec`
by status, and on approval opens a PR in the spec's namespace repo. reads
hedgedoc's `Notes`/`Users` and owns `spec_board_state`/`spec_board_meta`. the
only hedgedoc column it writes is `Notes.permission`, set to `locked` once on
approval; everything else in hedgedoc's tables is read-only.

## namespaces

a namespace is a target spec repo (`owner/repo`); every spec belongs to one
via `namespace: owner/repo` frontmatter (default: `DEFAULT_NAMESPACE`). the
allowlist is operator-controlled: only repos in the `NAMESPACES` env are
honored.

onboarding steps and the `.specs/roles.yml` schema:
[docs/onboarding.md](../docs/onboarding.md). the full note-to-PR flow:
[docs/spec-lifecycle.md](../docs/spec-lifecycle.md).

## config (env)

`NAMESPACES`, `DEFAULT_NAMESPACE`, `GITHUB_TOKEN`, `WEBHOOK_URL`,
`HEDGEDOC_BASE_URL`, `POLL_SECONDS`, `STALE_DAYS`, `FETCH_TIMEOUT_MS`, `PG*`.

## test

`node test.js` covers the pure logic (parsing, approval quorum, categories,
prefix, numbering, implements-refs).
