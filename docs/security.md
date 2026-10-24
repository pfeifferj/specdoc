# security and moderation

SpecDoc treats public note authors, remote model endpoints and MCP callers as
untrusted inputs. A project must admit an author's immutable GitHub identity
before that author's notes can consume automation or publish through the
project credential. The board can display an unadmitted public note without
granting it those capabilities.

The inherited editor still has dependency advisories that require integration
replacement or additional upgrades. See [dependency advisories](dependency-security.md)
for affected configurations, remaining work and deployment controls.

## upgrade an existing deployment

Back up PostgreSQL and uploads, stop the board and editor, and stage both new
images. The editor remains a single-instance service: never overlap old and new
editor replicas. Keep migration credentials out of runtime containers.

Create separate PostgreSQL roles and schemas for the editor, board migration
job and board runtime. `deploy/postgres/init.sql` demonstrates the grants for
the loopback development stack; its passwords are development fixtures, not
hosted deployment secrets. Existing databases need their existing
`spec_board_*` tables and sequences moved together into the board schema by
their owner. Do not create an empty parallel board state. The migration job
refuses a search path that would do that.

Use the migration role with search path `board_schema,editor_schema`, set
`BOARD_DB_RUNTIME_ROLE` and `EDITOR_DB_ROLE`, and run:

```sh
node server.js --migrate
```

Run this from the board image or `spec-board/`. The job installs schema changes,
restricted grants and narrow functions for locking notes/users and saving
verified email addresses. The editor can read only the three moderation tables
in the board schema. Start the board with its restricted runtime role and the
same search path. Startup checks the schema version and rejects excessive
privileges, including access to editor OAuth tokens. The editor must have the
board schema on its search path when board integration is enabled.

Update protected `.specs/roles.yml` files to numeric GitHub IDs, optionally with
display logins, as shown in [onboarding](onboarding.md). Set `BOARD_ADMIN_IDS`
and optional `BOARD_MODERATOR_IDS`; the old username-based `BOARD_ADMINS` setting
grants no authority. Review the identity mapping before applying it: resolving
a reclaimed username today does not establish who held it previously.

Existing approvals lack a candidate and stable subject binding and must be
given again. Existing supersession timestamps without verified receipts are
retained as evidence but no longer retire a spec. Reconcile legacy associations
against the target repository; do not manufacture receipts from live metadata.
Old board sessions must sign in again. Privileged actions require sign-in within
the last hour; ordinary sessions last eight hours.

## publication authority

A candidate includes the note identity, owner subject, title, namespace,
area/kind, dependencies, replacement relation, review body and policy hash.
Workflow tag transitions do not invalidate approval; semantic edits do.
Missing/malformed governance, hidden or non-public notes, unadmitted authors,
suspended accounts, blockers and stale approvals prevent publication.

The final transaction locks and rereads current state, then records the exact
authorized document, approving subjects and random submission ID. That commit
is the authorization cutoff. Remote writes and retries use those bytes.
Same-title notes cannot adopt each other's PRs. A merged PR alone cannot retire
another document: the merged file, destination, PR identity and metadata must
match the persisted intent. Cross-project supersession is refused.

An admin can reverse retirement by POSTing a reason and their current CSRF token
to `/admin/specs/NOTE_ID/unretire`. The decision is audited, and the same old
submission cannot immediately retire the target again.

## moderation and spam

Signed-in readers can choose **Report content** on a board card. Reports require
a category and reason. Duplicate reports by one account are combined; reports
are capped at five per account/day, 200 globally/day and 1,000 open entries.
Reports never automatically hide content. This prevents report brigading from
becoming a takedown mechanism.

Admins and configured moderators use `/moderation` to hide/restore a note,
suspend/restore a GitHub account, block/restore a local attachment, or close a
report. Every decision requires a
reason and records the moderator's immutable identity, target and previous
state. A suspension blocks writes and automation; hiding also removes public
note access. The editor rechecks restrictions on requests, persistence and live
sessions. Restoring access does not erase the audit trail. Closed report details
expire after 90 days; decision history remains for appeals and accountability.
Hiding a note does not remove copies already published to Git or sent to other
services. Handle those copies separately when a moderation decision requires it.
Attachments have separate URLs and no note ownership relation. To withdraw a
local attachment, choose `block-upload` and enter the exact filename at the end
of its `/uploads/` URL. The editor refuses future reads without deleting the
file, and `restore-upload` reverses the decision. Hiding a note does not do this
automatically. Files on external storage providers and already downloaded or
cached copies require separate takedown.

Creation quotas and duplicate detection in the editor constrain account and IP
spam. Project admission prevents arbitrary namespace claims from generating
PRs, review spend or subscriber mail. Upload, socket, operation and storage
limits prevent small documents from becoming unbounded work. Use verified login
and `CMD_ALLOW_ANONYMOUS=false` for deployments that do not need guest authors.

The board adds global and per-caller request budgets, concurrent-work limits,
bounded caches and a 200-card page limit. Notification queues coalesce hourly
duplicates and cap recipient, note, project and global backlog. A recipient gets
at most 200 queued events/day, and the deployment at most 20,000. Delivery drops
rows after seven days or 20 failed attempts. `NOTIFICATIONS_PAUSED=true` pauses
both enqueue and delivery. Webhooks neutralize mention syntax and have a
20-per-minute ceiling.

Rate limits are additional to edge protection. `TRUSTED_PROXIES=0` is the safe
direct-connection default. Configure exact proxy hops only behind a trusted
edge that strips inbound forwarding headers and prevents origin bypass. Keep
edge connection/body limits, volume quotas and disk alerts enabled. The editor
still holds collaboration state in one process, so adding replicas is not a
substitute for these controls.

## model boundaries and secrets

Set `MODEL_ALLOWED_ORIGINS` to exact HTTPS origins. Every connection validates
all DNS answers and rejects private, loopback, multicast and special-use
addresses; TLS verifies the original hostname. Redirects, URL credentials,
queries and fragments are rejected. Responses must be JSON and fit within 1 MiB.
`MODEL_ALLOW_LOOPBACK=true` is only for explicitly allowlisted numeric loopback
development endpoints. Apply an outbound network policy as an independent
boundary around hosted services.

All model consumers reserve durable daily call and conservative token budgets
before dispatch, including attempts that fail. These are request/input/output
ceilings, not currency accounting: set spending limits with the provider too.
`MODEL_AUTOMATION_DISABLED=true` is the global stop switch. Review scheduling
rotates project and bot opportunities. Corpus text is passed as data and model
output never authorizes publication or moderation.

Store a random 32-byte base64 `SPECDOC_SECRET_KEY` outside PostgreSQL and retain
it in your secret backup. Provider keys are encrypted with authenticated
encryption bound to the bot identity. The migration job encrypts legacy keys
when that secret is supplied; plaintext credentials are refused at dispatch.
Changing the encryption key without re-encrypting stored credentials makes them
unreadable. Provider-key rotation through `/bots` replaces the encrypted value.
Bot configuration changes, token issuance/revocation and deletion are audited
without storing credential values in the audit record.

The editor discards provider tokens after sign-in. The optional GitLab snippet
integration can retain an encrypted access token only with a separate external
`CMD_OAUTH_TOKEN_KEY` (32 bytes encoded as 64 hexadecimal characters). Encryption
is bound to the provider, provider subject and local account ID. Upgrades purge
existing provider tokens; signing in again restores the optional integration.
GitLab sign-in remains available without a token-storage key.

High-confidence private-key, GitHub-token and AWS-access-key patterns are blocked
before publication or external review. This is not a complete secret detector.
Rotate any exposed credential immediately. Public revisions, uploads, repository
history, backups and model-provider copies each need separate erasure handling.
The operator redaction command preserves receipt hashes and decision provenance
while removing retained bodies. Set `MAINTENANCE_DATABASE_URL` to the offline
owner connection with the board/editor search path and preview exact targets:

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

Repeat note/hash pairs when a shared snapshot requires multiple exact targets.
The command makes affected notes private and hidden and scrubs retained local
text, including complete map documents and checkpoint messages whose recorded
sources include an affected note. Those shared artifact receipts keep their
hashes, source candidate IDs, destinations and authorization timestamps, with a
redaction marker. Unrelated receipts are preserved. The command does not delete
current corrected content or rewrite remote repositories.

## MCP and monitoring

MCP reads stay inside the configured repository and explicitly granted
`SPECDOC_ALLOWED_ROOTS`. Nested manifests, bundle files and Git metadata are
checked before reading; self-contained checkouts avoid unsafe external Git
configuration and object-store indirection. Writes additionally require
`SPECDOC_ALLOW_WRITES=true`, a bot token and exact `SPECDOC_WRITE_NOTES` grants.
Give separate agent processes only the roots and note IDs they need.

Anonymous health endpoints reveal only `ok`. Detailed `/statusz` requires an
admin session or a `MONITORING_TOKEN` bearer of at least 32 characters. Monitor
quota refusals, moderation backlog, provider failures, storage pressure and
notification drops. Release checks cover runtime dependency audits, supported
Node images, authorization races and boundary regressions.
