# reading specs elsewhere

the board serves its corpus as json so tools other than a browser can read it.
the board routes are public, unauthenticated, and subject to the same per-ip
rate limit as the rest of the board (120 requests per 10 seconds). the editor's
[personal access token API](#personal-access-tokens) also reads private notes
and creates or updates notes, within the token owner's permissions.

notes the board hides from guests are absent from every response: hedgedoc's
`limited`, `protected` and `private` permissions are filtered out once, when the
poller builds its snapshot, and the list and body routes read only that
snapshot. a note that turns private drops out on the next poll that completes.
the revision routes ask the editor directly, which applies the same rule.

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
`prState`, `specPath`, `superseded`, `abstract`, `dependsOn`, `supersedes`.

`kind` is `feature` or `top-level`. a
[top-level spec](spec-lifecycle.md#top-level-specs) is what every feature spec
in the namespace inherits; an agent reading the corpus should read those first.

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
namespace repo, its revisions are pull requests against that file, and
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
board=https://specs.josie.cloud
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
`approvals`, `required`, `stale` (approvers the text moved past) and
`changesUrl`. `POST /api/note/<id>/approvals` with `{ token, action }` is
where the approve button records or retracts an approval; the token is the
identity assertion the editor signs. both routes name the editor origin alone
in their cors header and follow the editor fork's shape, so they are not a
contract for other tools; everything above is.

## context for agents

`mcp/` joins this api with the code in a checkout and serves it to a coding
agent one hop at a time: [context graph for agents](context-graph.md).

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
  https://md.josie.cloud/api/v1/notes
```

to edit an existing note, read it first and retain the `ETag` response header:

```sh
curl --fail-with-body -D /tmp/spec-headers \
  -H "Authorization: Bearer $SPECDOC_TOKEN" \
  https://md.josie.cloud/api/v1/notes/NOTE_ID > /tmp/spec-note.json
```

prepare the replacement markdown, then send the exact quoted ETag from that
response as `If-Match`, keeping the surrounding quotes as shown:

```sh
jq -Rs '{content: .}' < spec.md > /tmp/spec-payload.json
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $SPECDOC_TOKEN" \
  -H 'If-Match: "ETAG_FROM_GET"' \
  --json @/tmp/spec-payload.json \
  https://md.josie.cloud/api/v1/notes/NOTE_ID
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
`415`. `503` means the editor is starting or shutting down. creation may also
return `409` during a revision save. `If-Match: *` cannot replace the exact ETag.

the API limits each IP to 120 requests per minute and applies the configured
new-note limit per token owner. a `429` includes `Retry-After`. API and token
management responses use `Cache-Control: no-store`.
