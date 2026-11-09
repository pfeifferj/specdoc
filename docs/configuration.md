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
| `SPEC_BOARD_BASE_URL` | empty | the board's own public origin. email has no request to derive it from, and the github sign-in callback is built from it, so unset means no email and no sign-in |
| `BOARD_NAME` | `specdoc` | deployment display name in the header and page titles; rendered as text |
| `BOARD_THEME_DIR` | empty | directory of deployment-owned public assets; requires `theme.css`, with optional `icon.svg` and local fonts |
| `BOARD_REDIRECT_HOSTS` | empty | comma-separated old hosts to redirect with HTTP 308 to `SPEC_BOARD_BASE_URL`; preserves paths, queries, and request methods; requires an HTTPS origin |
| `PORT` | `8080` | listen port |
| `PG*` | libpq defaults | `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` for the editor's database. `PGUSER` is the runtime role, or the migration role for `--migrate`; its search path must name the board schema first, then the editor schema |
| `SPEC_TAG` | `spec` | frontmatter tag that marks a note as a spec |
| `POLL_SECONDS` | `60` | poll interval. one tick at a time, under a postgres advisory lock |
| `STALE_DAYS` | `14` | days without a change before a reviewing card gets a stale marker |
| `FETCH_TIMEOUT_MS` | `15000` | hard deadline on every outbound call and pg query, so a hung socket cannot wedge the poll loop |
| `TRUSTED_PROXIES` | `0` | reverse proxy hops in front of the board. `0` rate-limits by socket peer; `N` reads the caller's address `N` hops from the board's end of `X-Forwarded-For` (one openshift route is `1`). read [rate limiting](operations.md#rate-limiting) before raising it |
| `MONITORING_TOKEN` | unset | bearer token for the detailed `/statusz` reply; ignored when shorter than 32 characters |
| `BOARD_DB_RUNTIME_ROLE` | unset | read by the migration job: the existing role it grants the board's runtime privileges to. the board must then connect as that role |
| `EDITOR_DB_ROLE` | unset | read by the migration job, and only when `BOARD_DB_RUNTIME_ROLE` is set: the editor's role, granted `SELECT` on the three `spec_board_moderation_*` tables |
| `SPECDOC_AUTO_MIGRATE` | `false` | `true` runs the migration at startup and skips the runtime privilege check. refused unless `NODE_ENV=development`; deployments run `node server.js --migrate` as a separate job |
| `MAINTENANCE_DATABASE_URL` | unset | connection string for `node maintenance.js redact-history` only. its role must own the editor and board tables, directly or through an inherited role, and its search path must name the board schema, then the editor schema ([security](security.md)) |

board numeric settings reject non-finite, negative and out-of-range values at
startup. ports are 1 to 65535, proxy counts 0 to 32, poll seconds 1 to 86400,
fetch timeouts 1 to 300000 ms and overlap budgets 1 to 10000000 bytes. idle and
debounce minutes accept zero and fractions up to 10080; stale days accept 0 to
365000.

### github

| var | default | what it does |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | unset | per-project installation tokens; preferred, and self-refreshing |
| `GITHUB_TOKEN` | unset | service PAT: resolves `roles.yml`, scans for `implements` commits, and backs the app up where it is not installed |
| `PR_INTAKE` | `[]` | optional pull-request intake policies; see below |
| `DOCUMENTATION_FOLLOWUPS` | `[]` | optional model-assisted documentation updates after implementation PRs merge; see below |
| `SPECS_DIR` | `specs` | fallback target dir for spec files. a project's `specs-dir` in `roles.yml` wins ([onboarding](onboarding.md)) |

without either credential the board still renders specs, but resolves no
approvers and opens no PRs.

`PR_INTAKE` redirects outside pull requests to SpecDoc. Enable it only for
repositories dedicated to specs: it applies to every PR, including code and
configuration changes. An empty value or `[]` disables it. Each entry names a
repository already listed in `NAMESPACES`, its numeric organization ID, the
installed App's numeric bot account ID, and the HTTPS proposal URL:

```json
[{"namespace":"example/specs","organizationId":"12345","botId":"67890","proposalUrl":"https://specs.example.org/?ns=example%2Fspecs"}]
```

The App needs organization Members: read and repository Pull requests: write.
Its private key stays on the board. Intake uses a short-lived token with
Members: read for the organization, plus Pull requests: write and Metadata: read
for the configured repository. Publication in these repositories also requires
the App; a service PAT cannot substitute for it.

Active organization members and the configured bot can open PRs directly.
Other PRs receive a proposal link and are closed. Intake runs in bounded batches
during board polling, so closure can take several ticks. Each batch has a
30-second budget; an in-flight request may finish within its normal timeout.
Reopened PRs are checked again. PRs stay open if identity or membership cannot
be verified, an API call fails, or a scan limit is reached. `prIntake` in
`/statusz` reports failures, including budget deferrals. Repository files and
note text cannot enable or change this policy.

### notifications and email

| var | default | what it does |
| --- | --- | --- |
| `WEBHOOK_URL` | unset | posts status moves, comments, approvals, locks, PRs, supersedes and implementations |
| `NOTIFICATIONS_PAUSED` | `false` | pauses email enqueue and delivery without deleting the queue |
| `SMTP_HOST` | unset | enables digests, together with `SPEC_BOARD_BASE_URL` and `SESSION_SECRET` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | unset | omit for an unauthenticated relay |
| `SMTP_FROM` | `specdoc@localhost` | no-reply sender |
| `EMAIL_DEBOUNCE_MINUTES` | `30` | quiet period per recipient; each event resets it, and a burst collapses into one message |
| `REVIEW_REMINDER_HOURS` | `24` | wait after first observing a pending review version before reminding its remaining approvers; `0` disables reminders; accepts fractions up to 8760 |
| `EMAIL_ORG_NAME` | `SpecDoc` | sender identity in the mail footer |
| `EMAIL_POSTAL_ADDRESS` | empty | postal address in the footer, which bulk-mail rules expect |
| `PRIVACY_URL` | the board's `/privacy` | override for the data-handling notice linked from mail |
| `PRIVACY_CONTACT` | `SMTP_FROM` | address for data-handling requests, distinct from the no-reply sender |

email refuses to start without a signable unsubscribe link
([bootstrap](bootstrap.md#2-credentials) explains the rotation cost).

digests go only to addresses github marks verified on the user's linked
profile; local-account email fields and unverified addresses get no mail. a
delivery address chosen in `/settings` must be one of them, otherwise the
verified primary is used. signing in again refreshes the list. the board checks
verification again before sending and drops queued mail for unverified
addresses. commit-author email selection is separate.

before email or a note-specific webhook goes out, the board checks again that
the note is still public, not hidden and not owned by a suspended account.
preflight and bot-health notices carry no note text, and webhook text
neutralizes `@` mentions.

### settings page and review bots

| var | default | what it does |
| --- | --- | --- |
| `BOARD_OAUTH_CLIENT_ID`, `BOARD_OAUTH_CLIENT_SECRET` | unset | github oauth app for `/settings` and `/bots` |
| `SESSION_SECRET` | unset | signs board session cookies and unsubscribe tokens. required for both the settings page and email |
| `EDITOR_SECRET` | unset | shared with the editor's `CMD_SPEC_BOARD_SECRET`; verifies saved-version approval assertions and signs editor mutations. required for approvals, automatic locks and bot writes |
| `BOARD_ADMIN_IDS` | empty | comma-separated numeric GitHub IDs allowed to manage review bots at `/bots`, cut [checkpoints](spec-checkpoints.md) at `/checkpoints` and moderate |
| `BOARD_MODERATOR_IDS` | empty | comma-separated numeric GitHub IDs allowed to handle reports and restrictions at `/moderation`. admin and moderator actions need a sign-in within the last hour |
| `MODEL_ALLOWED_ORIGINS` | empty | comma-separated HTTPS origins, matched exactly, that model requests may go to. empty blocks every model request |
| `MODEL_ALLOW_LOOPBACK` | `false` | `true` admits a numeric loopback origin listed in `MODEL_ALLOWED_ORIGINS`, over HTTP or HTTPS, for development. other private and special-use addresses stay blocked |
| `SPECDOC_SECRET_KEY` | unset | 32 random bytes, base64-encoded, that encrypt bot API keys (AES-256-GCM). migration and startup require it whenever stored credentials exist; retain the same key outside postgres |
| `MODEL_AUTOMATION_DISABLED` | `false` | `true` refuses every model call, including checkpoint summaries and implementation feedback |
| `MODEL_DAILY_CALLS`, `MODEL_PROJECT_DAILY_CALLS` | `100`, `25` | daily model request ceilings, global and per project, stored in postgres. failed requests count |
| `MODEL_DAILY_TOKENS`, `MODEL_PROJECT_DAILY_TOKENS` | `2000000`, `500000` | daily token reservation ceilings, global and per project |
| `MODEL_COOLDOWN_SECONDS` | `60` | minimum interval between model calls triggered by the same note or job |
| `REVIEW_IDLE_MINUTES` | `10` | quiet time before a bot reviews a note; the editor separately refuses writes while the note is open |
| `OVERLAP_MAX_BYTES` | `200000` | budget for the checkpoint overlap pass, which sends a project's whole approved corpus in one request. size it to the model's context |

Each request reserves its serialized UTF-8 byte size, maximum output and a
safety margin. Work stopped before dispatch and failures to establish a TCP
connection return the token reservation. Request counts and cooldowns still apply. HTTP
errors and failures after connection keep the reservation because the provider
may have processed the request.

a bot itself lives in the database, one row per bot managed from `/bots`:
name, OpenAI-compatible endpoint, model, optional API key, prompt, request
settings, and the projects it reviews. The review fingerprint includes
prose, prompt, model, endpoint, request settings, the inherited
top-level specs and which peer specs were sent, but not
the peers' own text; changes schedule a fresh review within the poll budget.
Changing the endpoint URL or URL type clears the saved API key unless a
replacement is supplied.
a peer's revision therefore does not re-review every spec that names it, and
the conflict it introduces waits for that spec's own next edit or for the
checkpoint overlap pass.
ordinary findings land as `{>>@<name>: ...<<}` threads. a conflict supported by
exact quotes from both specs becomes one shared Discussion thread on both.
open threads block publication until resolved. repeated findings reuse the
shared thread without reopening it or replacing its discussion history.
troubleshooting is in [operations](operations.md#review-bot-failing).

Checkpoint overlap checks, checkpoint summaries and proposed-change summaries use the
first enabled bot assigned to the project, ordered by name. Individual spec
reviews run each assigned bot.

The endpoint must accept OpenAI Chat Completions requests and return the final
JSON in `choices[0].message.content`. On `/bots`, **Base URL** appends
`/v1/chat/completions`, or `/chat/completions` if the base already ends in `/v1`.
**Full completion URL** uses the supplied URL without appending a path. Use it
for services with a different route. Both URL types require an allowed origin
and the same HTTPS and address checks.

**Temperature** accepts a number from 0 to 2. Leave it blank to omit the parameter
and use the provider's default. Existing bots keep `0.2`.
**Token limit parameter** selects `max_tokens` or `max_completion_tokens`, according
to the model's API. SpecDoc sets the limit for each task; changing the parameter
name does not change the limit or the project's request budget.

JSON Schema is the default response format. For
endpoints that support only JSON object mode, select **JSON object** on `/bots`;
SpecDoc then includes the response schema in its instructions. Both modes validate
the result locally and reject blank, malformed or truncated responses. The configured prompt
applies to individual reviews; overlap checks, checkpoint and proposed-change
summaries, and implementation feedback use their own prompts. output limits are
3072 tokens for reviews, 4096 for overlaps, 2048 for checkpoint summaries, 1800
for proposed-change summaries and 5000 for feedback, within a 120-second request
deadline. For **Reasoning effort**, **Provider default** omits `reasoning_effort`; other choices send the
selected value. Choose an effort the endpoint supports. Reasoning may share the
output budget, so select **None** for endpoints that need thinking disabled to
leave room for final JSON. Reasoning belongs outside `message.content`.

size context for the task: reviews send up to 24000 characters plus 12000 of
inherited context, while feedback accepts up to 160000 characters and overlaps
use `OVERLAP_MAX_BYTES`. character and byte limits are not token counts. allow
space for the prompt and output, and reject oversized requests rather than
silently dropping source text.

Proposed-change summaries require an explicit request from the spec owner,
project approver or board admin. Public reads only retrieve cached results.
Discussion and summary permission checks refresh cached project policy at most
once every 30 seconds. New reviewers become eligible when the regular project
poll refreshes the roster. Approval and publication checks fetch current policy.
The input limits are 192,000 bytes of raw note, 28,000 bytes for each resolved
spec text, 100 discussion messages totaling 16,000 bytes including their source
IDs, 24,000 characters of diff excerpts and 100,000 bytes for the complete model
input. Exceeding a limit refuses generation without omitting messages or edits.

Each board process allows two summary generations at once, with a 30-second
cooldown per GitHub account and 10 seconds per project. Failed model attempts
also consume the cooldown. The shared `MODEL_COOLDOWN_SECONDS` limit also
applies per bot and note; its default is 60 seconds. Each process keeps up to
40 results or failures in memory; results expire after 15 minutes and failures
after one minute. Source, discussion,
publication and model changes invalidate cached results sooner. These are
per-process limits, so each replica has its own cache and generation allowance.

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

### documentation follow-ups

`DOCUMENTATION_FOLLOWUPS` maps a project to a documentation repository, existing
Markdown files and an enabled review bot assigned to that project:

```json
[{"namespace":"example/specs","targetRepo":"example/docs","paths":["docs/guide.md","docs/reference.md"],"exclude":[],"bot":"docs-bot"}]
```

source repositories come from the project's explicit `implementation-repos` in
`roles.yml`. the specs, source and documentation repositories must be public. paths
are exact file names, not globs; excluded files cannot be changed. the GitHub App
needs Contents: read on the specs repository, Contents: read and Pull requests:
write on implementation repositories, and Contents: write and Pull requests:
write on the documentation repository. a service PAT cannot substitute for it.

collection starts when each source is enabled and includes PRs merged into its
default branch, with or without a spec reference. after normal review and
publication work, the worker assesses one change using the existing model
budgets. if documentation needs updating,
it opens a PR and links it from the source PR for the author's review. it never
merges the update or overwrites a person's changes. unavailable input does not
count as a finding that no update is needed.

evidence must be text with complete patches: at most 32 changed files, 200 kB
of source evidence and 100 kB of documentation. the merged file versions must
match those returned by GitHub for the PR. changes outside these limits need
manual follow-up. proposals use the recorded documentation revision, so later
changes to the docs may require a rebase during review.

the model proposes small, exact Markdown edits. existing includes and complex
markup stay unchanged; large rewrites need a human edit. files must use LF line
endings.

an assessment stops after three model attempts; waiting for budget does not use
an attempt. unfinished work stops after 30 days. `documentation` in `/statusz`
reports pending, deferred, unchanged, completed and stopped work, with the latest reason.

### deployment themes

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
| `SPECDOC_BOT_TOKEN` | unset | a bot token from `/bots`. the [write tools](context-graph.md#writing-as-a-bot) also need the next two settings |
| `SPECDOC_ALLOWED_ROOTS` | `[]` | JSON array of directories it may read besides `SPECDOC_REPO`, which is always allowed. symlinks are resolved before the check, and bundle and manifest sources are checked too |
| `SPECDOC_ALLOW_WRITES` | `false` | `true` enables the write tools |
| `SPECDOC_WRITE_NOTES` | empty | comma-separated note IDs, at most 128, that the write tools may change |
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
with three defaults changed: `CMD_ENABLE_UPLOADS` is `registered` (an
unrecognized value disables uploads), and `CMD_CSP_ALLOW_FRAMING` and
`CMD_CSP_ALLOW_PDF_EMBED` are `false`. what a deployment has to set:

| var | what it does |
| --- | --- |
| `CMD_DB_URL` | the shared database, as the editor's own role. the editor creates the schema the board reads, so start it first |
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
| `CMD_OAUTH_TOKEN_KEY` | optional 32-byte key as 64 hex characters. with it, gitlab sign-in keeps an encrypted access token for snippet import and export; without it, snippets are off and gitlab sign-in still works. keep it outside the database and in the secret backup |
| `CMD_UPLOAD_MAX_BYTES` | per-upload limit: 5 MiB by default, 10 MiB at most |
| `CMD_UPLOAD_QUOTA_BYTES` | total size of the filesystem upload store, existing files included: 512 MiB by default. the store also stops at 10,000 files |

the [editor security limits](https://github.com/pfeifferj/specdoc/blob/master/editor/README.md#security-limits)
list the creation quotas, request and collaboration limits, moderation
enforcement and rendering restrictions.

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
