# configuration

every knob both services read. [bootstrap](bootstrap.md) is the order to set
them in; this page is the reference.

## spec board

### core

| var | default | what it does |
| --- | --- | --- |
| `NAMESPACES` | empty | comma-separated allowlist of target repos (`owner/repo`). specs pointing outside it render but never open PRs |
| `DEFAULT_NAMESPACE` | first of `NAMESPACES` | project for specs whose frontmatter names none. must match the editor's `CMD_SPEC_DEFAULT_NAMESPACE` |
| `HEDGEDOC_BASE_URL` | `http://localhost:3000` | where the editor is, for note links |
| `HEDGEDOC_INTERNAL_URL` | `HEDGEDOC_BASE_URL` | editor address used for signed board mutations; use an internal service address when available |
| `SPEC_BOARD_BASE_URL` | empty | the board's own public origin. email has no request to derive it from, so unset means no email |
| `BOARD_NAME` | `specdoc` | deployment display name in the header and page titles; rendered as text |
| `BOARD_THEME_DIR` | empty | directory of deployment-owned public assets; requires `theme.css`, with optional `icon.svg` and local fonts |
| `BOARD_REDIRECT_HOSTS` | empty | comma-separated old hosts to redirect with HTTP 308 to `SPEC_BOARD_BASE_URL`; preserves paths, queries, and request methods; requires an HTTPS origin |
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
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | unset | per-project installation tokens; preferred, and self-refreshing |
| `GITHUB_TOKEN` | unset | service PAT: resolves `roles.yml`, scans for `implements` commits, and backs the app up where it is not installed |
| `SPECS_DIR` | `specs` | fallback target dir for spec files. a project's `specs-dir` in `roles.yml` wins ([onboarding](onboarding.md)) |

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
| `OVERLAP_MAX_BYTES` | `200000` | budget for the checkpoint overlap pass, which sends a project's whole approved corpus in one request. size it to the model's context |

a bot itself lives in the database, one row per bot managed from `/bots`:
name, openai-compatible endpoint, model, optional api key, prompt, and the
projects it reviews. the review fingerprint includes prose, prompt, model,
endpoint, the inherited top-level specs and which peer specs were sent, but not
the peers' own text; changes schedule a fresh review within the poll budget.
a peer's revision therefore does not re-review every spec that names it, and
the conflict it introduces waits for that spec's own next edit or for the
checkpoint overlap pass.
most of its findings land as `{>>@<name>: ...<<}` threads that block approval
until resolved; a conflict it reports with another spec is advisory and shows on
the board card instead. troubleshooting is in [operations](operations.md#review-bot-failing).

the endpoint must support `/v1/chat/completions` with `response_format: json_schema`
and return the final JSON in `choices[0].message.content`. the configured prompt
applies to individual reviews; overlap checks, checkpoint summaries and
implementation feedback use their own prompts. output limits are 3072 tokens
for reviews, 4096 for overlaps, 2048 for summaries and 5000 for feedback, within
a 120-second request deadline. reasoning models must leave room in these limits
for the final JSON; cap thinking at the endpoint and return it separately from
`message.content`.

size context for the task: reviews send up to 24000 characters plus 12000 of
inherited context, while feedback accepts up to 160000 characters and overlaps
use `OVERLAP_MAX_BYTES`. character and byte limits are not token counts. allow
space for the prompt and output, and reject oversized requests rather than
silently dropping source text.

### implementation feedback

`feedback-bot: <name>` in a project's `roles.yml` selects an enabled bot
assigned to that project. no selection means no collection or generation.
with a bot selected, **automatic spec amendment proposals** is on unless a
project approver or board admin turns it off in `/settings`. this shared
project setting persists across restarts, separately from personal email
preferences. it pauses automatic work and prevents an in-flight result from
publishing after the setting changes. suggestions already in notes stay.

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

a bot can also hold a token, issued, replaced and revoked from its panel at
`/bots`; the board stores only a sha256 of it. the token authorizes the
[bot write api](api.md#bot-writes) for the bot's projects, which is what
the CLI's `review` commands and `mcp/`'s write tools use to let a local model review as that bot. leave
endpoint and model blank for a bot that exists only for this: the poller
never sends such a bot anything.

### Deployment themes

Mount or copy a dedicated public asset directory into the board image and set
`BOARD_THEME_DIR` to its absolute path. `theme.css` loads after the built-in
styles; use relative URLs for fonts and images. An optional `icon.svg` replaces
the header mark and favicons. Assets are read at startup and served under
`/theme/`; restart after changing them. CSS, SVG, PNG, WOFF2 and TXT files are
supported, including subdirectories. Hidden entries are skipped and symlinks
are rejected. Keep only public, trusted theme content in this directory.

SpecDoc ships no organization themes. Each deployment maintains its own assets,
licenses and `BOARD_NAME`; omitting these settings keeps the default appearance.

## specdoc CLI

`cli/` runs on the agent's or developer's machine. See [CLI usage](cli.md) for
installation, browser authorization and safe note updates.

| var | default | what it does |
| --- | --- | --- |
| `SPECDOC_CONFIG_DIR` | `$XDG_CONFIG_HOME/specdoc`, or `~/.config/specdoc` | versioned profiles and explicit file credentials |
| `SPECDOC_PROFILE` | saved default, then `default` | selected instance profile |
| `SPECDOC_EDITOR_URL` | saved profile | editor origin for author operations and login |
| `SPECDOC_BOARD_URL` | saved profile | board origin for specs and bot reviews |
| `SPECDOC_TOKEN` | stored author credential | author PAT; requires the matching editor URL in the environment |
| `SPECDOC_BOT_TOKEN` | unset | bot credential; requires the matching board URL in the environment |

URL flags override environment URLs, which override profile URLs. URLs must be
HTTPS origins; loopback HTTP is allowed for development. Credentials from
`--token-stdin` override environment credentials, which override stored ones.
Neither service URL is inferred from the other.

`auth login` defaults to the OS keyring. Linux uses Secret Service explicitly.
Machines without a keyring can select `--storage file`; there is no automatic
fallback. Storage is bound to profile, identity and origin. File credentials
and operation recovery records use private directories and `0600` files.

The editor's existing browser login provider and public URL settings power
device authorization; it needs no separate OAuth application registration.
The updated editor and board advertise supported protocols at
`/.well-known/specdoc`. Install both server updates before relying on browser
login and public mutation recovery.

## specdoc-mcp

the agent-facing server in `mcp/` ([context graph for agents](context-graph.md))
is configured from the environment of the process that starts it, usually an
`.mcp.json` in the implementation repo.

| var | default | what it does |
| --- | --- | --- |
| `SPECDOC_URL` | `http://localhost:8080` | the board whose `/api/specs` it reads |
| `SPECDOC_NAMESPACE` | derived | comma-separated spec repos to serve. unset, it is the set named by the checkout's `implements owner/repo#N` commits, and everything the board serves when there are none |
| `SPECDOC_REPO` | cwd | the checkout to index |
| `SPECDOC_MAX_TOKENS` | `1500` | default response budget, 50 to 20000; `context` raises defaults below 500 to 500. each tool call can pass its own `max_tokens` |
| `SPECDOC_BRIEF_TOKENS` | `1000` | size of the file `brief --out` writes and the `brief` tool's default, same range |
| `SPECDOC_BOT_TOKEN` | unset | a bot token from `/bots`. set, it adds the [write tools](context-graph.md#writing-as-a-bot) under that bot's name |
| `SPECDOC_LAYA_URL` | unset | loopback http or https base url for an optional laya service; `context` sends its task and candidate spec excerpts to `/v1/systemone/batch` for ranking |
| `SPECDOC_LAYA_MODEL` | `english` | model passed to the laya batch endpoint |
| `SPECDOC_LAYA_TIMEOUT_MS` | `2000` | deadline for laya ranking, 100 to 60000 milliseconds; longer values allow explicit cpu timing tests |
| `SPECDOC_LAYA_MAX_CANDIDATES` | `16` | number of complete optional sections to score, 1 to 16 |
| `SPECDOC_LAYA_BATCH_SIZE` | `8` | inference batch size within that request, 1 to 8; smaller batches may reduce padding but add forward passes |

laya is optional and configured by each developer. when unset, or when its
response fails, times out, is invalid or is truncated, task context uses word
matching. explicit spec and section anchors, top-level specs and dependencies
bypass model ranking. the laya service receives task text and candidate excerpts; its
operator controls logging and retention. specdoc does not save tasks or model
scores. see [context for a task](context-graph.md#context-for-a-task) for
section retrieval, caller-controlled receipts and the response budget.

## editor

the editor is a hedgedoc 1.x derivative and takes
[upstream's `CMD_*` configuration](https://docs.hedgedoc.org/configuration/)
unchanged. what a deployment has to set:

| var | what it does |
| --- | --- |
| `CMD_DB_URL` | the shared database. the editor creates the schema the board reads, so start it first |
| `CMD_DOMAIN`, `CMD_PROTOCOL_USESSL` | public hostname, used to build note URLs |
| `CMD_SESSION_SECRET` | session cookies |
| `CMD_GITHUB_CLIENTID`, `CMD_GITHUB_CLIENTSECRET` | github login with `read:user` and `user:email` for identity and verified email addresses; no repo scope |
| `CMD_IMAGE_UPLOAD_TYPE=filesystem` | uploads land on the RWO volume |

these settings exist only in this fork:

| var | what it does |
| --- | --- |
| `CMD_SPEC_BOARD_URL` | the board's public origin. allows it in the editor's CSP `connect-src`, so the approval widget can read project roles, and returns it as the CORS origin on `/me`. without it approvals never resolve |
| `CMD_SPEC_BOARD_SECRET` | the board's `EDITOR_SECRET`. verifies signed board mutations and signs five-minute GitHub approval assertions bound to note/action/saved text; unset, those routes return 404 |
| `CMD_SPEC_DEFAULT_NAMESPACE` | project prefilled into the `/new/spec` template. must match the board's `DEFAULT_NAMESPACE` |
| `CMD_THEME_DIR` | optional absolute path to public theme assets for the CLI browser authorization pages; empty keeps SpecDoc's default appearance |

CLI code entry, consent, confirmation and error pages share the editor's
charcoal and yellow appearance. To customize them, mount the same
[deployment theme](#deployment-themes) directory used by the board into the
editor and set `CMD_THEME_DIR` (or `themeDir` in `config.json`). Each service
reads its own local directory; no browser request to the board is needed.
This setting currently styles the CLI authorization pages, not the note editor.

`theme.css` loads after the defaults. The pages use the board's `--canvas`,
`--surface`, `--text`, `--muted`, `--border`, `--hover`, `--accent`,
`--accent-soft`, `--danger` and `--danger-soft` variables and `.primary`,
`.app-header`, `.brand` and `.app-footer` classes. Set `color-scheme` in the
theme when changing the default dark appearance. Use `.page-cli-auth` to
scope rules to these pages. An optional `icon.svg` replaces their header
mark and favicon. The visible application name remains SpecDoc.

The editor serves these assets under `/theme/` (beneath `CMD_URL_PATH` when
set), permits local theme CSS in its default content security policy, and
supports CSS, SVG, PNG, WOFF, WOFF2 and TXT files. With custom CSP defaults
disabled, allow the editor's theme URL in `style-src` and its origin in
`font-src`. Relative asset URLs keep fonts and images on the editor origin.
Hidden entries are skipped and symlinks are rejected; include only trusted
public content. Restart the editor after changes; theme responses revalidate
instead of retaining a stale stylesheet.

[compose.yaml](https://github.com/pfeifferj/specdoc/blob/master/compose.yaml)
is a complete working set of both.
