# reading specs elsewhere

the board serves its corpus as json so tools other than a browser can read it.
the board routes are public, unauthenticated, and subject to the same per-ip
rate limit as the rest of the board (120 requests per 10 seconds). the editor's
[personal access token API](#personal-access-tokens) also reads private notes
and creates or updates notes, within the token owner's permissions.

notes the board hides from guests are absent from every response: hedgedoc's
`limited`, `protected` and `private` permissions are filtered out when the
poller builds its snapshot and checked again on each public request. the board,
search, library, planning and APIs withhold cached content when the note is
private or deleted, and fail closed if that check fails. derived graphs and
milestone progress use the same visible set. content responses use `no-store`;
the guarantee applies when the request is authorized, not to copies already
downloaded. revision routes additionally check permission in the editor.

## routes

| route | returns |
|---|---|
| `GET /api/specs` | one page of specs as metadata, retired ones included. `?ns=owner/repo` and `?status=draft` filter, `?limit=` and `?cursor=` page |
| `GET /api/specs/<id>` | one spec, metadata plus `body`. `Accept: text/markdown` returns the body alone |
| `GET /api/specs/<id>/revisions` | that note's revision series, newest first |
| `GET /api/specs/<id>/revisions/<time>` | the raw markdown at `time`, or at `current` |
| `GET /api/specs/<id>/changes` | what changed between two snapshots: `?from=` and `?to=` take a snapshot id, `approval:<login>`, `status:<phase>`, `published:rN` or `current`; returns both anchors, the list of snapshots, the requirement ids added, removed and changed, and a word-level diff as `[op, text]` pairs |

`<id>` is the note's alias, its shortid, or the encoded uuid its url carries
when it has no alias.

## paging

`/api/specs` returns at most 500 specs and a `next` cursor, or `next: null` on
the last page. pass it back as `?cursor=` to continue. `?limit=` lowers the page
size but cannot raise it past 500.

the cursor is the position of the last spec you were given, not an offset, so a
spec published or retired mid-pull cannot shift the ones you have not reached:
you will not repeat a spec or skip one that was already ahead of you. a spec
that appears *behind* the cursor is simply not in that pull, which an offset
would instead pay for by dropping a different spec. `at` may change between
pages for the same reason; the cursor stays valid. a cursor you did not get from
`next` is a `400`, so a typo reads as an error rather than as the end of the
corpus.

`/api/specs` carries `at`, the iso time the snapshot was built, and `stale`,
set once that snapshot is older than three poll intervals. the content behind it
is older still: the poller reads the notes at the start of a tick and stamps
`at` at the end, and a tick that overruns skips the next interval. treat `at` as
a floor, not a guarantee.

per spec: `id`, `urlId`, `alias`, `title`, `url`, `status`, `area`, `kind`,
`namespace`, `tags`, `author`, `changed`, `comments`, `suggestions`, `pr`,
`prState`, `specPath`, `superseded`, `abstract`, `dependsOn`, `supersedes`,
`relationIssues`.

`relationIssues` lists malformed `depends-on` and `supersedes` values as
diagnostics with `code`, `severity`, `field`, optional `index` and `line`, and
`message`; `dependsOn` and `supersedes` still carry the valid references. an
empty list does not mean every target exists or provides what the spec needs.
the [spec lifecycle](spec-lifecycle.md#review) describes how the issues hold
publication; approvals are counted as usual.

`kind` is `feature` or `top-level`. a
[top-level spec](spec-lifecycle.md#top-level-specs) is what every feature spec
in the project inherits; an agent reading the corpus should read those first.

`superseded` matters if you are feeding this to an agent: the board hides a
retired spec, the api serves it. filter on it unless you want history.

`dependsOn` and `supersedes`
are the references the note declares, as `owner/repo#12` or a note id, not
resolved links: a draft's references are the interesting ones and the
[map](spec-lifecycle.md#the-map) only resolves approved specs.

## published body against raw note

`body` on `/api/specs/<id>` is the published form: frontmatter stripped and
criticmarkup resolved, the same text the spec pr would carry. that is what to
feed a model; raw `{>>...<<}` review threads are noise to it.

the revision endpoints serve the raw note instead, frontmatter and criticmarkup
included, so a diff across the series is not swamped by the difference between
the two forms.

## history

for a spec that has landed, git is the better source. the spec is a file in the
project's repo, its revisions are pull requests against that file, and
[checkpoints](spec-checkpoints.md) tag reconciled states:

```sh
git log -p --color-words specs/networking/012-route-policy.md
git diff specs/v2..specs/v3
```

`specPath` and `namespace` in the api response say where to look.

for what changed at review granularity, landed or not, `/changes` is the
better source: the board records the published form at each status change,
approval and publish, and its diff is word-level over that form, so
frontmatter and comment threads never show up as changes. `/changes/<id>` on
the board is the same comparison as a page.

the revision endpoints exist for specs that have not landed yet. two things to
know about them:

- an edit takes five to ten minutes to appear, because hedgedoc's saver runs on
  a five-minute timer that also wants the note idle. that is why the board
  offers `current` from its own copy; hedgedoc's `/<note>/revision` will never
  list the live document.
- only the newest revision holds full text. older ones are patches that hedgedoc
  reconstructs on request, so asking for many is not cheap.
- if the editor cannot be reached, the series still returns with `current`
  alone. a single revision returns `502` instead.

## pulling the corpus

```sh
board=https://specs.example.com
cursor=
while :; do
  page=$(curl -sf "$board/api/specs?ns=owner/repo&cursor=$cursor") || break
  jq -r '.specs[] | select(.superseded | not) | .id' <<<"$page" |
    while read -r id; do
      curl -sf -H 'Accept: text/markdown' "$board/api/specs/$id" > "$id.md" || echo "$id failed" >&2
      sleep 0.1
    done
  cursor=$(jq -r '.next // empty' <<<"$page")
  [ -n "$cursor" ] || break
done
```

two things that bite without them: `-sf`, or a `429` body lands in a file as
though it were the spec, and the `next` loop, or you silently take the first
page and call it the corpus. the sleep keeps a large pull under the rate limit.

for most questions the list alone is enough. it carries every title, area,
status and declared reference, which is the shape of the corpus without its
text.

## the editor's route

`GET /api/note/<id>` is what the editor's navbar reads: `status`, `area`,
`namespace`, `pr`, `prState`, `approvedBy` (the approvals on record),
`approvals`, `required`, `approverSubjects`, `approvedSubjects`, `relationIssues`,
`rolesUnknown`, `openDiscussions`, `discussionBlocksPublication`, `stale`
(approvers the text moved past) and `changesUrl`. `POST /api/note/<id>/approvals` with
`{ token, action }` is where the approve button records or retracts an
approval; the token is the version-1 assertion the editor signs after
confirming persistence. it binds
`purpose: spec-approval`, GitHub provider and subject, username, canonical note
shortid, action, content hash and expiry. approval fails with `409` if the text
changed before the board records it. unversioned assertions are refused.
both routes name the editor origin alone
in their cors header and follow the editor fork's shape, so they are not a
contract for other tools; everything above is.

### review discussions

`GET /api/note/<id>/review` returns the editor's general threads, messages,
approval activity and cached proposed-change summary. It starts no model work.
The response includes `sourceHash`, `openDiscussions`, the current review
`version`, an `approvals` record and pagination cursors.

Pass `after` for the next thread page or `threadId` to read one thread.
`messageAfter` continues that thread's messages and requires `threadId`;
`activityAfter` continues the activity history. Pages contain up to 20 threads,
20 messages per thread and 50 activity events. Use `nextCursor`, each thread's
`nextMessageCursor`, and `nextActivityCursor` to continue. Discussion messages
and approval/retraction events have stored actors and times; the API does not
invent events for approvals made before this history was deployed.
Messages from suspended accounts return `hidden: true` and a notice in place
of their text.

Shared findings have the same thread ID, messages and resolution on both specs.
Their `associations` identify each note, title, namespace and current content
hash. `evidence` contains the saved hash, quote and anchor for each source;
`evidenceStale` reports whether a source has since changed. `occurrenceKinds`
names the producers that recorded the finding (`spec-review` or `checkpoint`).
Frozen source bodies are served separately.

If either linked source is unavailable or moves to another project, the thread
returns `restricted: true`, its ID, version and resolution state, with empty
messages, associations and evidence. Its activity is omitted. Send
`visibleThreads` as up to 100 comma-separated cached thread IDs on subsequent
reads. `restrictedThreadIds` identifies cached threads that must be hidden,
including those outside the current page.
`visibleThreadStates` returns `{ id, version, resolved, restricted }` for each
requested thread associated with the current note. It lets clients update an
off-page thread's status or reload its messages when access returns. Unknown
or unrelated IDs have no state record and remain in `restrictedThreadIds`.

`GET /discussion/<threadId>/source/<sourceNoteId>?note=<id>` displays frozen
evidence while both sources remain available. `<id>` accepts a note short ID,
alias or encoded UUID. An unavailable linked source returns `409`.
`GET /discussion/<threadId>/recover?note=<id>` shows an administrator recovery
form for an unresolved restricted thread. Its POST requires recent admin
authentication, CSRF, the displayed `version` and a new `requestId`. It resolves
the shared block without revealing the hidden text. `recover` is not accepted
through the editor review API.

`POST /api/note/<id>/review` accepts `{ token, action, payload }`:

| action | payload |
| --- | --- |
| `thread` | `body`, `requestId` |
| `reply` | `threadId`, `version`, `body`, `requestId` |
| `resolve`, `reopen` | `threadId`, `version`, `requestId` |
| `summarize` | `sourceHash`, `requestId` |

The editor signs a version-1 `spec-review` assertion expiring within five
minutes. It binds the GitHub provider and subject, username, canonical note shortid, action,
`requestId`, expiry and `payloadHash`. The hash is SHA-256 of
`JSON.stringify(payload)` exactly as sent. A summary assertion also binds
`sourceHash` to the saved raw note. Approval assertions cannot authorize these
actions. The board allows up to 30 seconds of clock skew when checking the
maximum lifetime; expired assertions are still refused.

Request IDs contain 16 to 128 letters, digits, underscores or hyphens. Discussion
messages contain 1 to 8000 characters. Reply and state changes require the
current thread version; a stale version returns `409`. Repeating a discussion
request with its original ID returns the recorded result; using that ID for a
different payload returns `409`. Discussion writes share a limit of 30 per
minute per GitHub account across board replicas. Discussion and summary
requests also share a limit of 60 attempts per minute, including rejected
requests and retries, before remote permission checks run.

Error replies include a `code` when clients need to distinguish a conflict.
Keep the original request ID and payload after `review-busy` or HTTP `429`.
For `review-version`, reload the thread and submit the updated version with a
new request ID.
`review-sealed` explains that only the owner, project approvers and board admins
can add or reopen threads on a locked or approved spec. Review reads include
`discussionRestricted` for this state; it does not identify the current caller's
role.

Only the spec owner, project approvers and board admins can generate summaries.
Generation checks the current source and permissions again before accepting a
result. A ready summary includes `change`, nullable `reason`, exact
`changeQuotes` and `reasonQuotes`, the merged `before` identity (or `null` for
an addition), `afterHash`, `sourceHash`, model identity and `generatedAt`.
Other summary states are `pending`, `failed`, `unavailable` and `unchanged`;
`unchanged` means the candidate matches the merged text and needs no model call.
An uncached comparison returns `null`. See
[generation limits](configuration.md#settings-page-and-review-bots).

These routes allow the editor origin through CORS. They keep general discussion
and generated summaries outside the note's Markdown. Open general threads block
publication while reviewers can still record approvals.

## context for agents

the [CLI](cli.md) reads this API directly and joins specs with code in a
checkout. `mcp/` exposes the shared operations to MCP hosts:
[context graph for agents](context-graph.md).

## bot writes

a bot token from `/bots` (see [configuration](configuration.md#settings-page-and-review-bots))
authorizes `/api/bot/notes/<id>` for the public notes in that bot's projects,
sent as `Authorization: Bearer <token>`. there are no cors headers, so it is
not meant for use from a browser.

| route | body | answers |
|---|---|---|
| `GET /api/bot/notes/<id>` | | `id`, `title`, `namespace`, `status`, raw `content`, its `hash`, and `threads` (`id`, `author`, `text` of each open thread) |
| `POST .../comments` | `expectedHash`, `comments: [{ quote?, text }]` | `written`, `hash` |
| `POST .../suggestions` | `expectedHash`, `suggestions: [{ quote, replacement, rationale }]` | `written`, `placed`, `unanchored`, `hash` |
| `POST .../replies` | `expectedHash`, `thread`, `text` | `written`, `hash` |

each write takes 1 to 10 items. text and rationale are limited to 500
characters, a replacement to 2000, and the request body to 64KB. a
suggestion whose quote is no longer in the note is added as a comment
instead, and counts as `unanchored`. repeating a write the note already
holds returns `written: false`. a stale `expectedHash`, or a note the editor
is in the middle of changing, gets a 409. reconcile a stale hash before
submitting a new operation; a lost response must be recovered with its original
key and payload, as described under [durable mutation receipts](#durable-mutation-receipts).
comments and replies on an approved spec also get a 409, since only a
suggestion can reopen one. other errors: 401 for a missing, revoked or
disabled token; 404 for a note outside the bot's projects or a thread id
that is not open; 429 above 20 writes per 10 seconds from one address.

## personal access tokens

sign in to the editor, open the account menu on its home page, and choose
**Personal access tokens** (`/me/tokens`). give the token a name, choose read
access or read and write access, and set an expiry. the default lifetime is
30 days and the maximum is 365 days. copy the secret when it is displayed:
it is shown once. the same page lists tokens and revokes them. creation and
revocation are limited to ten attempts per account in five minutes.

tokens belong to the editor, not the board. send them in the
`Authorization: Bearer <token>` header to the editor's `/api/v1` routes.
query-string tokens and browser cookies do not authenticate these routes.
tokens cannot create other tokens or make review approvals; those operations
still require a browser login. revocation and expiry are checked on every
request.

| route | scope | result |
| --- | --- | --- |
| `GET /api/v1/notes/<id>` | `notes:read` | raw note content and its current ETag |
| `POST /api/v1/notes` | `notes:write` | creates a note owned by the token owner; `201` with its URL and ETag |
| `PUT /api/v1/notes/<id>` | `notes:write` | replaces content if `If-Match` matches and no editor is using the note |
| `GET /api/v1/auth` | any valid PAT | current user and safe token metadata |
| `DELETE /api/v1/auth/token` | any valid PAT | revokes the calling token |
| `GET /api/v1/operations/<key>` | `notes:write` | recovers an operation belonging to this user |

write tokens also have read access. `<id>` accepts the note's alias, shortid,
encoded UUID from its URL, or UUID. reads never create a missing note.
responses contain `id`, `url`, `title`, `content`, `permission`, and `updatedAt`.
`content` includes frontmatter and review comments, unlike the board's published
body. reads return the saved database text; an open editor may have newer edits.

POST and PUT take JSON with exactly one field, `content`, containing the complete
markdown. creation needs nonempty content and follows the editor's configured
default permission. updates may empty a note. both enforce the configured
document length limit, normalize line endings, and reject NUL characters.
ownership and permissions cannot be changed through these endpoints.

the existing note permissions apply: a token may read its owner's private
notes and notes available to signed-in users. locked, protected and private
notes can only be edited by their owner. editing a note preserves attribution
for unchanged text and attributes new text to the token owner. API edits enter
the editor's normal revision history, including its idle saving delay.

### create and update a note

with `SPECDOC_TOKEN` set to your token, create a note from a markdown file:

```sh
jq -Rs '{content: .}' < spec.md > /tmp/spec-payload.json
curl --fail-with-body \
  -H "Authorization: Bearer $SPECDOC_TOKEN" \
  --json @/tmp/spec-payload.json \
  https://md.example.com/api/v1/notes
```

to edit an existing note, read it first and retain the `ETag` response header:

```sh
curl --fail-with-body -D /tmp/spec-headers \
  -H "Authorization: Bearer $SPECDOC_TOKEN" \
  https://md.example.com/api/v1/notes/NOTE_ID > /tmp/spec-note.json
```

prepare the replacement markdown, then send the exact quoted ETag from that
response as `If-Match`, keeping the surrounding quotes as shown:

```sh
jq -Rs '{content: .}' < spec.md > /tmp/spec-payload.json
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $SPECDOC_TOKEN" \
  -H 'If-Match: "ETAG_FROM_GET"' \
  --json @/tmp/spec-payload.json \
  https://md.example.com/api/v1/notes/NOTE_ID
```

a `412` means the note changed: read it again and reconcile your edit before
retrying. a `409` means it is open in an editor, connecting, saving, or another
API update or revision save is underway. close the note's editor tabs and retry
after saving finishes. this restriction also applies when the open tab is your own; it keeps
the editor's in-memory copy from overwriting the API's change.

### errors and limits

errors are JSON with an `error` message. `401` means a missing, invalid, expired
or revoked token; `403` means insufficient scope or note permission, or disabled
note creation; `404` means an unknown or unreadable note; `428` means missing
`If-Match`; `412` means a stale precondition; `409` means a busy note. invalid
bodies return `400`, excessive content `413`, and unsupported content types
`415`. receipt expiry returns `410`; a key reused for different input returns
`409`. `503` means the editor is starting or shutting down. creation may also
return `409` during a revision save. `If-Match: *` cannot replace the exact ETag.

the API limits each IP to 120 requests per minute and applies the configured
new-note limit per token owner. a `429` includes `Retry-After`. API and token
management responses use `Cache-Control: no-store`.

## browser login for the CLI

`specdoc auth login` uses device authorization on local and remote terminals.
the terminal prints a link and short code; the browser signs in through the
editor's existing provider, shows the account, code, scope and lifetime, and
requires an explicit approval. the waiting terminal receives an expiring PAT.
there is no refresh token or loopback listener.

all protocol POSTs below take JSON. the public client id is `specdoc-cli`.

| route | input and behavior |
| --- | --- |
| `POST /oauth/device/code` | `client_id`, optional `scope` (`notes:read` or `notes:read notes:write`), `name`, `expires_in_days` (1 to 365, default 30). returns `device_code`, `user_code`, verification URLs, `expires_in: 600` and `interval: 5` |
| `GET /cli/authorize?user_code=...` | browser session login and consent page |
| `POST /cli/authorize` | browser form with session-bound `_csrf`, `user_code`, and `decision: approve` or `deny` |
| `POST /oauth/token` | `client_id`, `device_code`, and `grant_type: urn:ietf:params:oauth:grant-type:device_code`. returns a bearer `access_token`, lifetime, scope and safe user/token metadata once |
| `POST /oauth/device/cancel` | `client_id`, `device_code`. cancels the grant and revokes any PAT it issued; cancellation remains available for 24 hours after grant expiry |

poll no faster than the returned interval. `authorization_pending` means keep
waiting; `slow_down` increases the interval by five seconds. denial, expiry and
consumed grants return OAuth error codes. the server hashes both codes at rest
and serializes redemption, so concurrent polls cannot issue multiple tokens.
consent is bound to the browser account and individual grant.

after a lost token-exchange response, the CLI cancels the grant instead of
repeating issuance. cancellation failure is reported as unconfirmed cleanup;
the user can revoke the token from `/me/tokens`. login and consent routes are
rate limited and use `no-store`.

## durable mutation receipts

both services advertise capabilities at `GET /.well-known/specdoc`, including
`protocolVersion: 1`, their role and `capabilities.publicReceipts`. the editor
also advertises `deviceAuthorization`. clients must check receipt support
before automatically retrying a mutation against an older deployment.

send a UUID in `Idempotency-Key` for note creation, note replacement, or a bot
comment, suggestion or reply. keyed bot writes also require
`Prefer: return=minimal`. retain the same method, target, complete payload
and original `If-Match`/`expectedHash` on retries. reusing a key with different
input returns `409`. author keys belong to the editor user; bot keys belong to
the particular bot credential. rotating a bot token changes its receipt identity.

author writes with a key return compact results: `id`, `url`, `title`, `etag`,
`contentHash` and `written`. unkeyed writes retain their existing representation,
or return compact metadata when sent `Prefer: return=minimal`.
recover with `GET /api/v1/operations/<key>` on the editor or
`GET /api/bot/operations/<key>` on the board. recovery rechecks current token,
scope, note permissions and, for bots, project access and visibility.

the editor commits the note and receipt in one transaction. the board records
the prepared editor request and its internal operation id before sending it;
retries reuse that exact request across process restarts. a board receipt can
be `pending`, `completed` or `failed`; retrying a pending write with its
original key and input resumes it. an author receipt is `completed`.
notification delivery remains best effort and is not an exactly-once guarantee.

results are retained for seven days. expired results return `410`, while
non-content key records remain to prevent the same key executing again.
the board clears prepared source on completion, deletion or expiry.
deleted or newly inaccessible notes cannot be recovered. a `404` alone does
not prove an earlier write failed: authorization or deletion can hide it.

## roadmap

spec summaries also include `milestone` (null or `{id, title, dueDate, state}`)
and `implementers` (an array of `{id, login, name}` public user identities).
implementation assignees are distinct from the spec author.

- `GET /api/milestones`: milestone metadata and implementation progress.
- `GET /api/milestones/<id>`: one milestone and its visible spec dependency nodes.
- `GET /api/roadmap`: visible specs with dependencies, implementation readiness,
  dependency step (`wave`, zero-based), blockers, milestone and implementers.

filters: `ns=owner/repo`, `state=open|closed`, `milestone=<id>|none`, and
`implementer=<user-id>|none|me` for spec nodes. `me` requires a board session. results use
100-item pages selected by `page=0`, with `nextPage` null at the end. the
milestone list paginates milestones; detail and roadmap endpoints paginate nodes.
the roadmap includes up to 100 milestone summaries; use `/api/milestones` to
page through the complete list.

responses include the spec snapshot time (`at`) and `stale` flag. planning
changes are read directly from storage, while implementation state follows the
normal poll interval. json spec summaries and roadmap responses use `no-store`
so assignment changes are immediately visible. hidden specs never appear in nodes; milestone progress
is marked `incomplete` if some assigned work cannot be shown. dependencies
outside a filtered selection retain public links. unknown or hidden targets
have no resolved id or title.

these endpoints are read-only. assignment and milestone changes use the signed-in
roadmap forms and require a project approver or board admin.
