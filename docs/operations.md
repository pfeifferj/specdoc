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
| `/statusz` | 200 while the poller is healthy, 503 once `lastPollOk` is older than 3 poll intervals. point external checks here. the body also carries `githubEnabled`, `failingBots`, `publishBackoff` (specs whose PR push is backing off) and `namespacesFailingPreflight`, so a 503 page arrives with the reason rather than five candidates |
| `/api/namespaces` | per-namespace preflight (`repo`, `push`, `roles` should be `pass`; `protection` may stay `unknown`) plus `poller.stale` |
| `/bots` | admin login. a failing review bot shows its failure count and last error, in memory, reset by a restart |
| `/checkpoints` | admin login. per-namespace [checkpoint](spec-checkpoints.md) state and what still blocks a cut |

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
          spec_path = NULL, published_hash = NULL, revision = NULL, revision_pr = NULL
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
`REVIEW_IDLE_MINUTES`, whose content hash differs from `spec_board_reviews`.
force one:

```sql
DELETE FROM spec_board_reviews WHERE note_id = '<shortid>' AND bot_name = '<bot>';
```

if the symptoms contradict the stored config, suspect the code path rather than
the data.

## checkpoint will not cut

the button is disabled while the namespace has blockers, and each one names the
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
drifted, and `no spec map at the repo apex` for a namespace with `specs-dir: .`.

## email

- digests debounce `EMAIL_DEBOUNCE_MINUTES` per recipient and flush at the
  latest after eight times that. rows reaching 20 failed sends are dropped with
  a webhook notification; smtp errors log as `email to <addr>:`.
- opt-outs are one-way hashes in `spec_board_optout`. re-enabling from the
  settings page clears them for all of a user's verified addresses.

## implements scan lag

`scan: <repo> exceeded the page cap` in the log means an implementation repo has
more than ~5000 commits newer than the scan cursor. the scan holds its cursor
for 3 polls, then advances past the backlog and sends a notification naming the
skipped window; `implements` refs in that window go undetected. the cursor lives in `spec_board_meta` under
`last_commit_scan:<repo>`: set it to an ISO timestamp to re-scan from a point,
delete it to scan from the repo's start.

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

## deploying a change

that depends on how you run it. the reference deployment builds in-cluster and
rolls out on an image trigger; its commands, its rollback tags and its backup
job are documented in
[specdoc-infra](https://github.com/pfeifferj/specdoc-infra/blob/master/docs/operations.md).

the two constraints from [architecture](architecture.md) hold wherever it runs:
single replica, and forward-only schema. rolling back across a destructive
migration means restoring from a dump.
