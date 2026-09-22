# operations

what breaks and what to check. commands run against the database and the board's
own endpoints, so they hold wherever you deploy it; `<sql>` is a psql session on
the shared database.

the poller ticks every `POLL_SECONDS` (default 60) under a postgres advisory
lock. [architecture](architecture.md) has the rest.

## endpoints

| path | meaning |
| --- | --- |
| `/healthz` | process alive, always 200. point liveness probes here |
| `/statusz` | external monitoring: 503 for a stale poller, failed mail/implementation scan, or missing publication identity guard. cached `subsystems` show success/failure times, consecutive failures, mail queue count/oldest age and scan backlog; `publicationSchema` identifies a repairable index problem. github quota/backoff, bot failures and project preflight remain visible. no recipient addresses are exposed |
| `/api/specs` | the corpus as json for external tools ([reading specs elsewhere](api.md)). public, current-permission checked |
| `/api/namespaces` | per-project preflight (`repo`, `push`, `roles` should be `pass`; `protection` may stay `unknown`) plus `poller.stale` |
| `/bots` | admin login. a failing review bot shows its failure count and last error, in memory, reset by a restart |
| `/checkpoints` | admin login. per-project [checkpoint](spec-checkpoints.md) state and what still blocks a cut |

## poller stale

`/statusz` returns 503, or the board shows the stale banner.

1. read the board's log for `poll:` errors. the tick is serial, so one slow
   dependency stalls everything.
2. check the database is reachable: `<sql> -c 'select 1'`. every board query
   carries a 15s statement timeout, so a dead database shows as repeated
   timeouts rather than a hang.
3. github problems appear as `gh:`, `scan:` or `app token:` lines. installation
   tokens refresh themselves; a lone 401 at the expiry boundary heals next tick.
4. restart only if the process itself is wedged. it drains the running tick
   first.

## redo a spec PR

for "the PR came out wrong": wrong area, wrong content, closed by mistake. a
closed PR whose branch is gone reads as a deliberate redo; a closed PR whose
branch still exists reads as a rejection and re-links.

1. fix the cause first (note frontmatter, `roles.yml`), or the redo reproduces
   it. the area is pinned in the state row when the PR opens, so editing
   frontmatter alone does not re-path an existing PR.
2. `gh pr close <N> -R <owner/repo> --delete-branch`
3. clear the pin:

   ```sql
   UPDATE spec_board_state
      SET pr_number = NULL, pr_state = NULL, category = NULL,
          spec_path = NULL, published_hash = NULL, published_commit = NULL, revision = NULL, revision_pr = NULL
    WHERE note_id = '<shortid>';
   ```

   add `implemented_at = NULL` for a spec that already shipped, or it stays in
   the implemented lane and the scan skips its new PR. leave `locked_at`: the
   lock is a one-shot transition and re-forcing it overrides an owner unlock.

4. the next poll opens a fresh PR.

## review bot failing

failures back off exponentially, up to 60 ticks between attempts, so a quiet log
does not mean recovered. check `/bots`.

| symptom | cause | action |
| --- | --- | --- |
| `401` | endpoint rejected the api key | verify the key against the endpoint by hand, paste the working one into `/bots` |
| `5xx` | model origin down or overloaded | the backoff covers bursts; act only if it persists |
| healthy but never reviews | nothing is eligible | see below |

a review fires only for a spec in `ready-for-review` or `in-review`, idle for
`REVIEW_IDLE_MINUTES`, whose review fingerprint differs from `spec_board_reviews`.
the fingerprint includes prose, effective prompt, model, endpoint and inherited
context; changing any of those can schedule another review within the existing
per-tick budget. bot comments wait until editor tabs close. force one:

```sql
DELETE FROM spec_board_reviews WHERE note_id = '<shortid>' AND bot_name = '<bot>';
```

if the symptoms contradict the stored config, suspect the code path rather than
the data.

## rate limiting

the board allows 120 requests per 10 seconds per caller, and answers `429` with
`Retry-After: 10`. `/healthz`, `/statusz` and static assets are exempt.
`/changes/<note>` and `/api/specs/<id>/changes` share a second bucket of 20 per
10 seconds, since each request there runs a word diff.

who counts as one caller depends on `TRUSTED_PROXIES`
([configuration](configuration.md)). it defaults to `1`, matching a single
openshift route: the address is read one hop from the board's end of
`X-Forwarded-For`, which is what the route observed and what no caller can
write. get this wrong in either direction and the limiter stops working. too
high and a caller picks its own bucket by sending the header; too low and every
request behind the proxy shares one bucket, so ordinary traffic trips the limit.

## checkpoint will not cut

the button is disabled while the project has blockers, and each one names the
spec or file and how to clear it ([checkpoints](spec-checkpoints.md) has the
table). a `post` sent anyway is refused with `N unresolved`. what else stops a
cut:

- `the board snapshot is stale, wait for the next poll`. every check compares
  the repo tree against the poller's view, and a replica that has not polled
  has none. one poll clears it; `/statusz` says whether the poller is healthy.
- `overlap findings not acknowledged`. tick the box. if a spec merged since the
  page loaded, the pass reruns and the count can change, so reload and re-tick.
- a github error from the tag write. tags are not branch-protected, but a tag
  ruleset can still refuse `refs/tags/specs/*`, and the app installation needs
  `contents: write`. `/api/namespaces` shows whether preflight passes.

the map refresh button reports `the map is already current` when nothing has
drifted, and `no spec map at the repo apex` for a project with `specs-dir: .`.

## approval not counted

a name in `approved-by` with no approval on the board shows as pending on the
card and in the roster. the board only counts approvals its own route
recorded ([review](spec-lifecycle.md#review)); the editor writes the name
after that. usual causes: the name was typed by hand, the approval predates
the board recording them, or the click failed. the approve button says why
it failed: the two services do not share a secret (`EDITOR_SECRET` on the
board, `CMD_SPEC_BOARD_SECRET` on the editor), the login is not in
`roles.yml`, the board has not polled the note yet, or the spec is not under
review. a `409` also means the text changed after the editor saved it; review
the latest text and retry. old clients must reload after a protocol upgrade.
the board logs each recorded click as `approval: approve <login> on
<note>`. the fix is always the approver clicking approve again.

## stale-approval mail missing

the mail goes to the approver's delivery address (`/settings`, else the
account's), through the same mute and opt-out as every other line, and only
after the note has sat idle for `REVIEW_IDLE_MINUTES`. it is sent once per new
text: `notified_hash` on the approval row in `spec_board_snapshots` records
which. a link in it to a snapshot that has since been replaced (the approver
retracted and re-approved) lands on the default comparison with a notice.

## email

- digests become due after `EMAIL_DEBOUNCE_MINUTES` of quiet or eight times
  that age. each poll attempts at most eight recipients and 200 rows per
  recipient, with a five-second admission budget; an active SMTP attempt may
  finish after it. older recipients rotate fairly across polls. the board
  snapshot is published before delivery starts. rows reaching 20 failed sends
  are dropped and `/statusz` records `DeliveryExhausted` and a dropped count.
- opt-outs are one-way hashes in `spec_board_optout`. re-enabling from the
  settings page clears them for all of a user's verified addresses.
- attempted recipients wait one debounce window before their next batch.
  new activity does not reset that retry clock. restricted or deleted notes
  are removed from the outgoing digest after a current visibility check.

## missing snapshot text

`snapshot <id> has no stored text` means an older snapshot reference has no
body. new references are protected by a foreign key, and snapshot writes hold
their bodies through commit. the constraint initially leaves existing rows
unvalidated so an old orphan does not prevent startup. inspect them with:

```sql
SELECT s.id, s.note_id, s.kind, s.label, s.hash
FROM spec_board_snapshots s
LEFT JOIN spec_board_snapshot_bodies b ON b.hash = s.hash
WHERE b.hash IS NULL;
```

recover missing text from database backups before validating the constraint:

```sql
ALTER TABLE spec_board_snapshots VALIDATE CONSTRAINT spec_board_snapshot_body_fk;
```

## implements scan lag

the scan compares immutable default-branch SHAs, so an old side-branch commit
newly reached by a merge is included. each repository processes at most two
pages per poll and persists its pending target and next page with the detected
implementation events. it never advances past an unprocessed page.

`/statusz` reports pending repositories, oldest pending time and failures under
`subsystems.implementationScan`. a first scan, missing old commit or rewritten
branch performs resumable full reconciliation. cursor JSON lives in
`spec_board_meta` at `implementation_scan:v1:<repo>`; deleting that key requests
a full reconciliation. the old `last_commit_scan:<repo>` key is retained for
rollback and is no longer read by this version.

## editor and board upgrade

deploy the editor before the board, with the same `CMD_SPEC_BOARD_SECRET` and
`EDITOR_SECRET`. `HEDGEDOC_INTERNAL_URL` can point board mutations at an internal
editor address; it defaults to `HEDGEDOC_BASE_URL`. the v1 route signs the exact
request body and refuses old or incompatible protocols. there is no direct SQL
fallback. restart the editor with replacement rollout, never parallel replicas.
reload open editor pages to obtain the version-bound approval client.
let the old board process drain before replacing it; older versions do not
honor the new publication generation and permission intent guards.

`permission_intent` preserves an unfinished lock operation and its original
permission; leave it intact while recovering the editor. `409` means an open or
busy note; `412` discards an unapplied stale intent and replans next poll. editor
receipts are committed with mutations, so a lost response can be retried safely.
receipts and permission ownership records are deleted with their note. preserve
the editor's generated canonical short IDs; do not reuse one for a different note.
locks created before this protocol lack editor ownership: reopening clears the
board's old lock record but leaves the permission for the owner to restore once.
accounts with ambiguous legacy provider metadata remain separate rather than
being silently linked; verify ownership before an administrator migrates one.

publication recovery reads the file at the original or revision PR's immutable
merge commit, including edits made during GitHub review. an unavailable or
ambiguous file leaves publishing pending. never set `published_hash` from the
current note to clear that condition.
`publication_generation` increases when a poller claims publication work. delayed
completions only update state, snapshots and queued events while they still own
that generation. leave this counter intact during recovery.

## publication identity guard

if `publicationSchema.ready` is false, reads remain available while publishing
and PR relinking are disabled. inspect duplicate `(namespace, pr_number)` rows
and the definition/validity of `spec_board_state_ns_pr`. resolve duplicate claims
from the actual PR history before recreating the unique partial index. the next
poll checks the guard again. a timeout is also degraded, not a successful migration.

on shutdown, new work stops and read/model requests are cancelled. acknowledged
remote writes can finish their local state transactions before the pool closes.
a separate 25-second deadline exits even if a connection never drains; the next
process reconciles uncertain editor mutations and GitHub publications.

## rotating credentials

| credential | how | cost |
| --- | --- | --- |
| `SESSION_SECRET` | replace, restart the board | logs everyone out, dead-links every unsubscribe URL already sent. no dual-key path, so rotate only on suspected compromise |
| `GITHUB_TOKEN`, app private key | replace, restart the board | none |
| bot `api_key` | `/bots`, paste the new key | none, leave blank to keep the current one |

## backup and restore

back up the shared database with `pg_dump -Fc`. custom format means restore is
`pg_restore`, not `psql`:

```sh
# stop both services first so nothing writes mid-restore
pg_restore -U <user> -d <db> --clean --if-exists <dump>
```

the editor's uploads live on a filesystem volume. whatever covers the database
does not cover them.

## implementation feedback

`/statusz` includes aggregate feedback counts for proposals waiting to be
placed, due jobs, discovery failures and paused projects. a proposal waits
while its note is open or was edited within `REVIEW_IDLE_MINUTES`, and stays
parked while its source is unavailable or private.

if proposals do not appear, check the project's `feedback-bot` selection,
the bot's enabled state and project assignment, and the automatic-proposals
toggle in settings. the service credential needs issues and pull requests
read access in each implementation repo, and contents read access in the
canonical spec repo. implementation-repo access is checked before initial
discovery and each daily reconciliation. the PR must have merged
and its description must name a tracked spec with `implements`.

discovery saves partial sweeps and retries failed requests without treating a
page cap as success. incomplete or oversized evidence does not call the model.
PRs that merged outside the 30-day discovery window are not picked up.

a placed proposal is a suggestion in the note; accepting or rejecting it there
is the decision, and the board keeps no separate record of it. proposal
payloads expire 90 days after placement. feedback tables are covered by the
ordinary database backup.

## deploying a change

that depends on how you run it. the reference deployment builds in-cluster and
rolls out on an image trigger; its commands, its rollback tags and its backup
job are documented in
[specdoc-infra](https://github.com/pfeifferj/specdoc-infra/blob/master/docs/operations.md).

the two constraints from [architecture](architecture.md) hold wherever it runs:
single replica, and forward-only schema. rolling back across a destructive
migration means restoring from a dump.
