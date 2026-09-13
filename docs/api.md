# reading specs elsewhere

the board serves its corpus as json so tools other than a browser can read it.
everything below is public, unauthenticated, and subject to the same per-ip rate
limit as the rest of the board (120 requests per 10 seconds).

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

## context for agents over mcp

`mcp/` in this repo is a small [model context protocol](https://modelcontextprotocol.io)
server that joins the list above with the code in a checkout, so a coding
agent can ask for the little it needs instead of loading a corpus or a
tree. it runs next to the agent, over stdio, in the implementation repo:

```json
{
  "mcpServers": {
    "specdoc": {
      "command": "node",
      "args": ["/path/to/specdoc/mcp/server.js"],
      "env": { "SPECDOC_URL": "https://specs.josie.cloud" }
    }
  }
}
```

it reads two things and writes nothing: this api, over the same
unauthenticated routes, and the working tree plus `git log` of the
directory it starts in. symbols come from tree-sitter (rust today; a
language is one grammar package and one line in `mcp/index.js`). the
index follows the working tree, so an agent's uncommitted edits are in
it, and every response opens with the commit it reflects:

```
index 3f2a9c1+dirty: 212 files, 1840 symbols; specs: 14 (netfyr/specs)
```

which spec repos it reads comes from the checkout's own `implements
owner/repo#N` commits, or from `SPECDOC_NAMESPACE`; a checkout with
neither sees every namespace the board serves.

five tools, no resources, no query language:

| tool | returns |
|---|---|
| `search(query, kind?, level?, limit?)` | symbols by name then by path fragment, specs by words in title or abstract. `level` is `fold` (one line), `preview` (plus signature or abstract) or `full` (plus source) |
| `neighbors(id, direction?)` | one hop: a symbol's callers and callees and the specs its file implements; a spec's `depends-on`, dependents, `supersedes` and the commits and files that implement it; a file's symbols and the files that use them |
| `get(id)` | a symbol's source, a file's outline, or a spec's published body with its implementing commits |
| `trace(id)` | spec to commits to files to symbols, or a symbol or file back to the specs its commits name |
| `brief(max_tokens?)` | a map to start a task with: the spec index and the most referenced symbols, signatures only |

ids are what the tools print: `sym:<path>#<name>` (`@<line>` when a file
defines the name twice), `file:<path>`, `spec:<owner/repo#N>` or the
note's shortid, `commit:<sha>`. bare forms are guessed, so
`src/dhcp.rs#refresh` and `netfyr/specs#7` both work.

every tool takes `max_tokens` (default `SPECDOC_MAX_TOKENS`, 1500) and
drops whole items past it, ending with how many were cut and which
argument narrows the question. there is deliberately no way to ask for
two hops: the measured effect of flattening a wider neighbourhood into a
prompt is worse than no graph at all, so an agent walks one hop at a time.

the same map is available without mcp:

```sh
node /path/to/specdoc/mcp/server.js brief --out .specdoc/brief.md
```

writes about a thousand tokens for a `CLAUDE.md` to pull in with
`@.specdoc/brief.md`; `SPECDOC_BRIEF_TOKENS` changes the size. it goes
stale the way any generated file does, so regenerate it from a git hook
or leave it to the tool.
