# spec-board

kanban board + automation for hedgedoc spec notes. groups notes tagged `spec`
by status, and on approval opens a PR in the spec's namespace repo. reads
hedgedoc's `Notes`/`Users` and owns its `spec_board_*` tables. it writes two
hedgedoc columns: `Notes.permission`, set to `locked` once on approval, and
`Notes.content`, only to add review-bot comments where a review bot is
assigned to the namespace; everything else in hedgedoc's tables is read-only.

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

review bots live in the database rather than the environment: one
`spec_board_bots` row each, managed at `/bots` by the logins in
`BOARD_ADMINS`. a row is a name, an openai-compatible endpoint URL, a model,
an optional API key (plaintext in postgres, the same store as hedgedoc's own
OAuth tokens), a prompt, the namespaces it reviews, and an enabled flag.

## privacy

`privacyPage` (`/privacy`) is the data-handling notice. any change that stores,
sends, or publishes user data must update it in the same commit.

## test

`node test.js` covers the pure logic (parsing, approval quorum, areas,
prefix, numbering, implements-refs).
