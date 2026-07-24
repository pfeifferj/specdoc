# operations runbook

Board internals assumed throughout: the poller runs every `POLL_SECONDS`
(default 60) under a Postgres advisory lock, keeps its own state in
`spec_board_*` tables, and never writes HedgeDoc's tables except
`Notes.permission` (post-approval lock) and bot comments in `Notes.content`.

## monitoring endpoints

- `/healthz`: process-alive only, always 200. Kubelet probes point here; do
  not move them.
- `/statusz`: 200 while the poller is healthy, 503 once `lastPollOk` is older
  than 3 poll intervals. Point external status checks here.
- `/api/namespaces`: per-namespace preflight (`repo`, `push`, `roles` should
  be `pass`; `protection` may stay `unknown`) plus `poller.stale`.
- `/bots` (admin login): a failing review bot shows a red banner with its
  failure count and last error. In-memory, resets on pod restart.

## poller stale

`/statusz` 503 or the board banner. In order:

1. `oc -n hedgedoc logs deploy/spec-board --since=10m` and look for `poll:`
   errors. The tick is serial; one slow dependency stalls everything.
2. DB reachable? `oc -n hedgedoc exec -i deploy/hedgedoc-postgres -- psql -U
   hedgedoc -d hedgedoc -c 'select 1'`. Every board query carries a 15s
   statement timeout, so a dead DB shows as repeated timeouts, not a hang.
3. GitHub errors (401/403/rate limit) show as `gh:`/`scan:`/`app token:`
   lines. Installation tokens self-refresh; a one-off 401 at the expiry
   boundary heals on the next tick.
4. A restart only helps if the process itself is wedged:
   `oc -n hedgedoc rollout restart deploy/spec-board`.

## redo a spec PR

The supported path for "the PR came out wrong, open it again" (wrong area,
wrong content, closed by mistake). The board treats a closed PR whose branch
is gone as a deliberate redo.

1. Fix the cause first (note frontmatter, roles.yml) or the redo reproduces
   the mistake. The area is pinned in the state row when the PR opens; a
   frontmatter edit alone does not re-path an existing PR.
2. Close the PR and delete its branch:
   `gh pr close <N> -R <owner/repo> --delete-branch`
3. Clear the pin so the poller re-opens instead of re-linking:

   ```sql
   UPDATE spec_board_state
     SET pr_number = NULL, pr_state = NULL, category = NULL
     WHERE note_id = '<shortid>';
   ```

4. Next poll opens the fresh PR. A closed PR whose branch still exists is a
   rejection and re-links instead; the branch deletion is what marks a redo.

Worked example: netfyr/specs SPEC-000 was re-pathed to `meta/` this way on
2026-07-24 (PRs 7-9 closed, PR 10 final).

## review bot failing

Symptoms: red banner on `/bots`, `review [...]: <bot> <status>` log lines.
Failures back off exponentially (up to 60 ticks between attempts), so a quiet
log does not mean recovered; check `/bots`.

- `401`: the endpoint rejected the API key. Verify the key against the
  endpoint by hand, then paste the working key into `/bots` (leave blank to
  keep, tick enabled). Keys live in the `spec_board_bots` table.
- `5xx`: the model origin is down or overloaded; the backoff handles bursts,
  nothing to do unless it persists.
- Bot healthy but never reviews: reviews fire only for specs in
  ready-for-review/in-review, idle for `REVIEW_IDLE_MINUTES`, whose content
  hash differs from `spec_board_reviews`. Delete that row to force a
  re-review:
  `DELETE FROM spec_board_reviews WHERE note_id='<shortid>' AND bot_name='<bot>';`

Case study (2026-07-23): every bot call 401'd for hours with a valid key in
the DB. Root cause was a second `loadBots` function declaration shadowing the
poller's (no api_key selected, enabled filter lost). If symptoms contradict
the stored config, suspect the code path, not the data.

## email

- Digests debounce `EMAIL_DEBOUNCE_MINUTES` per recipient, flush at the
  latest after 8x that. Rows with 20 failed sends are dropped with a webhook
  notification; SMTP errors are `email to <addr>:` log lines.
- Opt-outs are one-way hashes in `spec_board_optout`; the settings page
  re-enable clears them for all of a user's verified addresses.

## implements scan lag

A `Commit scan for <repo> hit the page cap` or `was truncated 3 polls in a
row` webhook means an implementation repo has more than ~5000 commits newer
than the scan cursor. The scan holds its cursor and retries for 3 polls; if
still truncated, it advances past the backlog and announces the skipped
window (implements-refs on commits in that window will not be detected). This
only happens on a cold cursor against a very busy repo; the cursor lives in
`spec_board_meta` under `last_commit_scan:<repo>`. To force a full re-scan
from a known point, set that row's value to an ISO timestamp (or delete it to
scan from the repo's start).

## secret rotation

`SESSION_SECRET` signs sessions, CSRF tokens, and unsubscribe links (the last
with a 2-year TTL). Rotating it logs every user out and dead-links every
unsubscribe URL already delivered; there is no dual-key grace path, so rotate
only on suspected compromise. `GITHUB_TOKEN` and the GitHub App key rotate in
`hedgedoc-secrets` followed by a board restart. Bot `api_key`s rotate through
`/bots` (paste the new key, leave blank to keep).

## backup and restore

The `postgres-backup` CronJob writes a nightly `pg_dump -Fc` custom-format
dump to a same-node hostPath (`deploy/chart/templates/postgres-backup.yaml`;
verify-then-publish, so `hedgedoc-<date>.dump` is always a `pg_restore
--list`-verified file). Custom format means restore is `pg_restore`, not
`psql`:

```sh
oc -n hedgedoc scale deploy/hedgedoc deploy/spec-board --replicas=0
oc cp <backups-host-dir>/hedgedoc-<date>.dump hedgedoc/<pg-pod>:/tmp/restore.dump
oc -n hedgedoc exec <pg-pod> -- \
  pg_restore -U hedgedoc -d hedgedoc --clean --if-exists /tmp/restore.dump
oc -n hedgedoc scale deploy/hedgedoc deploy/spec-board --replicas=1
```

Scale the app pods to 0 first so nothing writes mid-restore. `--clean
--if-exists` drops and recreates objects in place, so no manual DROP DATABASE.

Known gap: same-node hostPath, so this survives app corruption and accidental
deletion, not disk or node loss. The editor's filesystem uploads PVC is not
covered by any backup.

## deploy

- Board: build `spec-board/buildah-build.sh spec-board:vNN`, push to the
  internal registry (`oc registry login`), bump the tag in
  `deploy/local/spec-board.yaml`, `oc apply -f`, watch
  `oc -n hedgedoc rollout status deploy/spec-board`. Strategy is Recreate on
  purpose: two pollers can double-open PRs.
- Schema migrates forward-only at startup. Rolling the image back does NOT
  roll the schema back; check `ensureState` in `spec-board/server.js` for
  DROPs before pinning an old tag.
- Editor: patches live on the `critic` branch in `editor/.work`, backed by
  `editor/critic.bundle`. Rebuild via `editor/buildah-build.sh editor/.work
  <tag>`, deploy through the editor helm release.
