# configuration

every knob both services read. [bootstrap](bootstrap.md) is the order to set
them in; this page is the reference.

## spec board

### core

| var | default | what it does |
| --- | --- | --- |
| `NAMESPACES` | empty | comma-separated allowlist of target repos (`owner/repo`). specs pointing outside it render but never open PRs |
| `DEFAULT_NAMESPACE` | first of `NAMESPACES` | namespace for specs whose frontmatter names none. must match the editor's `CMD_SPEC_DEFAULT_NAMESPACE` |
| `HEDGEDOC_BASE_URL` | `http://localhost:3000` | where the editor is, for note links |
| `HEDGEDOC_INTERNAL_URL` | `HEDGEDOC_BASE_URL` | editor address used for signed board mutations; use an internal service address when available |
| `SPEC_BOARD_BASE_URL` | empty | the board's own public origin. email has no request to derive it from, so unset means no email |
| `PORT` | `8080` | listen port |
| `PG*` | libpq defaults | `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; the same database the editor uses |
| `SPEC_TAG` | `spec` | frontmatter tag that marks a note as a spec |
| `POLL_SECONDS` | `60` | poll interval. one tick at a time, under a postgres advisory lock |
| `STALE_DAYS` | `14` | days without a change before a reviewing card gets a stale marker |
| `FETCH_TIMEOUT_MS` | `15000` | hard deadline on every outbound call and pg query, so a hung socket cannot wedge the poll loop |
| `TRUSTED_PROXIES` | `1` | reverse proxies in front of the board. the rate limiter reads the caller's address this many hops from its own end of `X-Forwarded-For`, so a caller cannot pick its own bucket. one openshift route is `1`; set `0` if nothing fronts the board, or a caller writes the header itself |

board numeric settings reject non-finite, negative and out-of-range values at
startup. ports are 1–65535, proxy counts 0–32, poll seconds 1–86400, fetch
timeouts 1–300000 ms and overlap budgets 1–10000000 bytes. idle and debounce
minutes accept zero and fractions up to 10080; stale days accept 0–365000.

### github

| var | default | what it does |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | unset | per-namespace installation tokens; preferred, and self-refreshing |
| `GITHUB_TOKEN` | unset | service PAT: resolves `roles.yml`, scans for `implements` commits, and backs the app up where it is not installed |
| `SPECS_DIR` | `specs` | fallback target dir for spec files. a namespace's `specs-dir` in `roles.yml` wins ([onboarding](onboarding.md)) |

without either credential the board still renders specs, but resolves no
approvers and opens no PRs.

### notifications and email

| var | default | what it does |
| --- | --- | --- |
| `WEBHOOK_URL` | unset | posts status moves, comments, approvals, locks, PRs, supersedes and implementations |
| `SMTP_HOST` | unset | enables digests, together with `SPEC_BOARD_BASE_URL` and `SESSION_SECRET` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | unset | omit for an unauthenticated relay |
| `SMTP_FROM` | `specdoc@localhost` | no-reply sender |
| `EMAIL_DEBOUNCE_MINUTES` | `30` | quiet period per recipient; each event resets it, and a burst collapses into one message |
| `EMAIL_ORG_NAME` | `SpecDoc` | sender identity in the mail footer |
| `EMAIL_POSTAL_ADDRESS` | empty | postal address in the footer, which bulk-mail rules expect |
| `PRIVACY_URL` | the board's `/privacy` | override for the data-handling notice linked from mail |
| `PRIVACY_CONTACT` | `SMTP_FROM` | address for data-handling requests, distinct from the no-reply sender |

email refuses to start without a signable unsubscribe link
([bootstrap](bootstrap.md#2-credentials) explains the rotation cost).

### settings page and review bots

| var | default | what it does |
| --- | --- | --- |
| `BOARD_OAUTH_CLIENT_ID`, `BOARD_OAUTH_CLIENT_SECRET` | unset | github oauth app for `/settings` and `/bots` |
| `SESSION_SECRET` | unset | signs board session cookies and unsubscribe tokens. required for both the settings page and email |
| `EDITOR_SECRET` | unset | shared with the editor's `CMD_SPEC_BOARD_SECRET`; verifies saved-version approval assertions and signs editor mutations. required for approvals, automatic locks and bot writes |
| `BOARD_ADMINS` | empty | comma-separated github logins allowed to manage review bots at `/bots` and cut [checkpoints](spec-checkpoints.md) at `/checkpoints` |
| `REVIEW_IDLE_MINUTES` | `10` | quiet time before a bot reviews a note; the editor separately refuses writes while the note is open |
| `OVERLAP_MAX_BYTES` | `200000` | budget for the checkpoint overlap pass, which sends a namespace's whole approved corpus in one request. size it to the model's context |

a bot itself lives in the database, one row per bot managed from `/bots`:
name, openai-compatible endpoint, model, optional api key, prompt, and the
namespaces it reviews. the review fingerprint includes prose, prompt, model,
endpoint and inherited context; changes schedule a fresh review within the poll budget.
its findings land as `{>>@<name>: ...<<}` threads that block approval until
resolved. troubleshooting is in [operations](operations.md#review-bot-failing).

### implementation feedback

`feedback-bot: <name>` in a namespace's `roles.yml` selects an enabled bot
assigned to that namespace. no selection means no collection or generation.
with a bot selected, **automatic spec amendment proposals** is on unless a
namespace approver or board admin turns it off in `/settings`. this shared
namespace setting persists across restarts, separately from personal email
preferences. it pauses automatic work and prevents an in-flight result from
publishing after the setting changes. existing proposals and explicit imports
remain available.

generation happens after a linked implementation PR merges. discovery starts
with PRs updated within 30 days and reconciles that rolling window daily.
tracked merged PRs refresh at most daily until 30 days after merge. an explicit
import performs one fresh pass for an older merged PR. implementation PR
descriptions carry the same `implements` reference syntax as commits.

feedback shares the existing four model calls per poll and takes at most one
slot. one repository discovery step reads at most two pages; discovery and
source work share a 64-request budget. discussion and file lists are capped at five pages
each, collected evidence at 200 kB, and model input at 160,000 characters.
incomplete input is reported for retry rather than treated as no findings.

## specdoc-mcp

the agent-facing server in `mcp/` ([context graph for agents](context-graph.md))
is configured from the environment of the process that starts it, usually an
`.mcp.json` in the implementation repo.

| var | default | what it does |
| --- | --- | --- |
| `SPECDOC_URL` | `https://specs.josie.cloud` | the board whose `/api/specs` it reads |
| `SPECDOC_NAMESPACE` | derived | comma-separated spec repos to serve. unset, it is the set named by the checkout's `implements owner/repo#N` commits, and everything the board serves when there are none |
| `SPECDOC_REPO` | cwd | the checkout to index |
| `SPECDOC_MAX_TOKENS` | `1500` | default response budget, 50 to 20000; each tool call can pass its own `max_tokens` |
| `SPECDOC_BRIEF_TOKENS` | `1000` | size of the file `brief --out` writes and the `brief` tool's default, same range |

## editor

the editor is a hedgedoc 1.x derivative and takes
[upstream's `CMD_*` configuration](https://docs.hedgedoc.org/configuration/)
unchanged. what a deployment has to set:

| var | what it does |
| --- | --- |
| `CMD_DB_URL` | the shared database. the editor creates the schema the board reads, so start it first |
| `CMD_DOMAIN`, `CMD_PROTOCOL_USESSL` | public hostname, used to build note URLs |
| `CMD_SESSION_SECRET` | session cookies |
| `CMD_GITHUB_CLIENTID`, `CMD_GITHUB_CLIENTSECRET` | github login. the fork asks for no repo scope: the editor only needs identity |
| `CMD_IMAGE_UPLOAD_TYPE=filesystem` | uploads land on the RWO volume |

these settings exist only in this fork:

| var | what it does |
| --- | --- |
| `CMD_SPEC_BOARD_URL` | the board's public origin. allows it in the editor's CSP `connect-src`, so the approval widget can read namespace roles, and returns it as the CORS origin on `/me`. without it approvals never resolve |
| `CMD_SPEC_BOARD_SECRET` | the board's `EDITOR_SECRET`. verifies signed board mutations and signs five-minute GitHub approval assertions bound to note/action/saved text; unset, those routes return 404 |
| `CMD_SPEC_DEFAULT_NAMESPACE` | namespace prefilled into the `/new/spec` template. must match the board's `DEFAULT_NAMESPACE` |

[compose.yaml](https://github.com/pfeifferj/specdoc/blob/master/compose.yaml)
is a complete working set of both.
