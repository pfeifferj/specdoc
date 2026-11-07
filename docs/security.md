# security and moderation

SpecDoc treats public note authors, remote model endpoints and MCP callers as
untrusted. A project must admit an author's immutable GitHub identity before
that author's notes can consume automation or publish through the project
credential. The board can display an unadmitted public note without granting
it those capabilities.

The inherited editor has open dependency advisories; see
[dependency advisories](dependency-security.md) for affected configurations,
deployment controls and remaining work.

## deployment requirements

Use separate database roles for the editor, board migrations and board runtime.
Keep migration credentials out of both runtime services. The board's search
path must list its own schema before the editor schema.
The editor also needs the board schema on its search path for moderation reads.
Board startup checks the schema version and refuses excessive runtime privileges.
[Bootstrap](bootstrap.md) covers role creation and database migrations.

When model-provider keys are stored, supply the same `SPECDOC_SECRET_KEY` to
the migration job and board runtime.

Project roles, `BOARD_ADMIN_IDS` and `BOARD_MODERATOR_IDS` use numeric GitHub
account IDs. Login labels grant no authority. See [onboarding](onboarding.md)
for the protected `roles.yml` format.

## publication authority

An approval counts only for the candidate it was given for: the note ID, owner
subject, title, namespace, area and kind, dependencies, supersession relation,
public visibility, review body and policy hash. Workflow tag transitions do not
invalidate approval; semantic edits do. Missing or malformed governance, hidden
or non-public notes, unadmitted authors, suspended accounts, blockers and stale
approvals prevent publication.

Approvals need the approver's account ID and the current candidate and policy
hashes. Records without those bindings do not count.

The final database transaction locks and rereads current state, then records
the authorized document, the approving subjects and a random submission ID.
Authorization is fixed when that transaction commits; remote writes and
retries reuse the recorded bytes. Same-title notes cannot adopt each other's
PRs. A merged PR alone cannot retire another document: the merged file,
destination, PR identity and metadata must match the recorded intent.
Cross-project supersession is refused.

An admin can reverse a retirement by POSTing a reason and their current CSRF
token to `/admin/specs/NOTE_ID/unretire`. The reversal is audited, and the
submission that retired the note cannot retire it again.

Privileged actions require sign-in within the last hour; ordinary sessions
last eight hours.

## moderation and spam

Signed-in readers can report a board card with **Report content**, giving a
category and reason. Repeat reports of one note by one account are combined.
Reports are capped at five per account per day, 200 per day across the
deployment and 1,000 open. Reports never hide content automatically, so mass
reporting cannot take a note down.

Admins and configured moderators use `/moderation` to hide or restore a note,
suspend or restore a GitHub account, block or restore a local attachment, and
close reports. Every decision requires a reason and records the moderator's
immutable identity, the target and its previous state. A suspension blocks
writes and automation. Its general discussion messages are replaced with a
notice in public reads and model context, and queued message excerpts are not
delivered. Restoring the account makes those retained messages visible again.
Hiding removes public access to the note. The
editor rechecks these restrictions on requests, on saves and in live sessions.
Closed report details expire after 90 days; decisions, including restorations,
stay in the history for appeals and accountability.

Attachments have their own URLs and no link to a note, so hiding a note leaves
them readable. To withdraw a local attachment, choose `block-upload` and enter
the filename from the end of its `/uploads/` URL. The editor refuses later
reads without deleting the file; `restore-upload` reverses the block. Neither
action reaches copies outside the deployment: Git history, delivered mail and
webhooks, model providers, external storage providers, backups, and downloaded
or cached files need separate takedown.

The editor limits note creation per account, address and day, and refuses
repeated content. Notes from unadmitted authors cannot open PRs, spend review
budget or mail subscribers, whatever project they name. Upload, socket, OT
history and storage caps bound the work one note or client can cause; the
[editor security limits](https://github.com/pfeifferj/specdoc/blob/master/editor/README.md#security-limits)
list them. Deployments without guest authors should require verified login and
set `CMD_ALLOW_ANONYMOUS=false`.

The board adds global and per-caller request budgets, concurrency limits,
bounded caches and a 200-card page limit. Notification queues coalesce hourly
duplicates and cap the backlog per recipient, note, project and deployment. A
recipient gets at most 200 queued events per day, and the deployment at most
20,000. Delivery drops rows after 20 failed attempts or the longer of seven
days and nine digest intervals, allowing long digest intervals to become due.
`NOTIFICATIONS_PAUSED=true` pauses enqueue and delivery. Webhooks neutralize
mention syntax and post at most 20 times per minute.

Rate limits do not replace edge protection. Keep edge connection and body
limits, volume quotas and disk alerts enabled, and set `TRUSTED_PROXIES` as
described in [rate limiting](operations.md#rate-limiting). The editor keeps
collaboration state in one process, so adding replicas does not substitute for
these controls.

## model boundaries and secrets

`MODEL_ALLOWED_ORIGINS` lists exact HTTPS origins. Each connection checks every
DNS answer and rejects private, loopback, multicast and special-use addresses;
TLS verifies the original hostname. Redirects, URL credentials, queries and
fragments are refused. Responses must be uncompressed JSON of at most 1 MiB.
`MODEL_ALLOW_LOOPBACK=true` admits allowlisted numeric loopback origins, for
development only. Put hosted services behind an outbound network policy as an
independent boundary.

All model consumers reserve durable daily call and conservative token budgets
before dispatch, including for attempts that fail. These ceilings count
requests and tokens, so set spending limits with the provider as well.
`MODEL_AUTOMATION_DISABLED=true` stops all model use. Each poll makes at most
four review calls, one per project, and rotates which projects and bots go
first. Corpus text is passed as data, and model output never authorizes
publication or moderation.

Store a random 32-byte base64 `SPECDOC_SECRET_KEY` outside PostgreSQL and keep
it in your secret backup. Provider keys are encrypted with authenticated
encryption bound to the bot identity. Changing the key without re-encrypting
stored credentials makes them unreadable. Rotating a provider key through
`/bots` replaces the encrypted value. Bot configuration changes, token issuance
and revocation, and deletion are audited without storing credential values.

The editor discards provider tokens after sign-in. The optional GitLab snippet
integration keeps an encrypted access token only when a separate external
`CMD_OAUTH_TOKEN_KEY` is set ([configuration](configuration.md#editor));
encryption is bound to the provider, provider subject and local account ID.
GitLab sign-in works without the key.

High-confidence private-key, GitHub-token and AWS-access-key patterns are
blocked before publication or external review. This is not a complete secret
detector; rotate any exposed credential immediately.

`maintenance.js redact-history` removes retained local bodies but keeps receipt
hashes and decision provenance. Set `MAINTENANCE_DATABASE_URL` to a
maintenance-only connection whose role owns both the editor and board tables or
inherits from their owners, with search path `board_schema,editor_schema`.
Preview the targets:

```sh
node maintenance.js redact-history --note NOTE_ID
```

Correct the current text, stop both services, and review the preview's shared
snapshot references and current content hashes before applying:

```sh
node maintenance.js redact-history --note NOTE_ID --apply --offline \
  --actor NUMERIC_GITHUB_ID --reason 'Remove exposed credential history' \
  --expected-hash NOTE_ID=SHA256_FROM_PREVIEW
```

Repeat the note and hash pairs when a shared snapshot requires several targets.
The command makes affected notes private and hidden and scrubs retained local
text, including general discussion messages, complete map documents and
checkpoint messages whose recorded sources include an affected note. Those shared artifact receipts keep their
hashes, source candidate IDs, destinations and authorization timestamps, plus a
redaction marker. Discussion messages keep their identities and timestamps,
with a notice in place of the removed text. Unrelated receipts are untouched.
The command leaves the corrected current text in place and does not reach uploads, logs or the
external copies listed under [moderation](#moderation-and-spam).

## MCP and monitoring

MCP reads stay inside the configured repository and the roots listed in
`SPECDOC_ALLOWED_ROOTS`. Nested manifests, bundle files and Git metadata are
checked against those roots before reading. Git configuration includes, filters
and object alternates are refused, so serve MCP from a self-contained checkout.
Writes also require `SPECDOC_ALLOW_WRITES=true`, a bot token and exact
`SPECDOC_WRITE_NOTES` grants. Give each agent process only the roots and note
IDs it needs.

Anonymous health replies contain only `ok`. Detailed `/statusz` requires an
admin session or a `MONITORING_TOKEN` bearer of at least 32 characters. Monitor
quota refusals, moderation backlog, provider failures, storage pressure and
notification drops. CI audits dependencies, builds the board image on its
pinned Node release, and runs regression tests for authorization races and
security boundaries.
