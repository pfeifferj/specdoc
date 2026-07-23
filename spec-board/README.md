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

## config (env)

core: `NAMESPACES`, `DEFAULT_NAMESPACE`, `HEDGEDOC_BASE_URL`,
`SPEC_BOARD_BASE_URL` (public origin of the board, for links in email),
`PORT`, `PG*`, `SPEC_TAG` (default `spec`), `POLL_SECONDS`, `STALE_DAYS`,
`FETCH_TIMEOUT_MS`.

github: `GITHUB_TOKEN` (service PAT: roles, scans, PR fallback), or
`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` for per-namespace app tokens with
the PAT as fallback. `SPECS_DIR` (default `specs`) is the target-repo dir
specs land in; changing it orphans already-published specs.

notifications: `WEBHOOK_URL`. email needs `SMTP_HOST` + `SPEC_BOARD_BASE_URL`
+ `SESSION_SECRET` (compliant unsubscribe links); also `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
`EMAIL_DEBOUNCE_MINUTES`, `EMAIL_ORG_NAME`, `EMAIL_POSTAL_ADDRESS`,
`PRIVACY_URL`, `PRIVACY_CONTACT`.

settings page: `BOARD_OAUTH_CLIENT_ID` + `BOARD_OAUTH_CLIENT_SECRET` +
`SESSION_SECRET`. rotating `SESSION_SECRET` invalidates sessions and every
unsubscribe link already sent.

review bots: managed at `/bots` by the github logins in `BOARD_ADMINS`
(comma list; needs the settings-page vars). each bot is a `spec_board_bots`
row: name, openai-compatible endpoint URL, model, optional API key
(stored plaintext in postgres, the same store as hedgedoc's own OAuth
tokens), prompt, assigned namespaces, enabled. a bot reviews only namespaces
assigned to it, once per prose version; its findings land in the note as
`{>>@<name>: ...<<}` threads that block approval until resolved.
`REVIEW_IDLE_MINUTES` (default 10) is the quiet time since the note's last
edit before a bot writes into it.

## privacy

`privacyPage` (`/privacy`) is the data-handling notice. any change that stores,
sends, or publishes user data must update it in the same commit.

## test

`node test.js` covers the pure logic (parsing, approval quorum, categories,
prefix, numbering, implements-refs).
