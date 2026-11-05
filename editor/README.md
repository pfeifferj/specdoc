# editor

container image of hedgedoc 1.x with criticmarkup review: inline comment
threads with replies, suggestions with accept/reject, spec approvals in the
navbar. drop-in for the official `hedgedoc/hedgedoc` image: same `CMD_*` env
config, port 3000, postgres-ready. the defaults that differ are under
[security limits](#security-limits).

## why it rebases

the review features started in the
[bexelbie criticmarkup fork](https://github.com/bexelbie/hedgedoc). specdoc
carries those commits and its own as a series rebased onto each upstream
release rather than as a snapshot, so the editor keeps receiving upstream's
security fixes. two files define the editor source:

- `UPSTREAM`: the upstream release tag the series sits on.
- `critic.bundle`: a git bundle of every commit above that tag.

`Containerfile.src` clones upstream at that tag, fetches the bundle, and
installs dependencies; `Containerfile` applies the rebrand overlay and builds.
`BUILDER=buildah` on hosts where rootless podman cannot mount an overlay over
the context. builds never rebase; `rebase.sh` is a maintenance step run by
hand ([releases and rebases](../docs/release.md)).

## recovering a lost .work checkout

`critic.bundle` is the only copy of the fork's commits that leaves your
machine, so the working tree is reconstructible from this repo alone:

```sh
git init .work && cd .work
git remote add up https://github.com/hedgedoc/hedgedoc.git
git fetch --tags up
git fetch ../critic.bundle critic:critic && git checkout critic
```

`../hack/checkout-critic.sh <dir>` does the same without the dependency
install.

## notes

- build and runtime images pin node 24.22.1, and `Containerfile` refuses a
  source image built on another release, since native dependencies must match
  the runtime. `hack/build-editor.sh` tags the source image with a hash of
  `Containerfile.src`, so changing the pin there rebuilds it.
- the patch ledger is `FORK.md` on the `critic` branch, not in this tree. it
  has the full limits and migrations summarized below.

## security limits

uploads need a signed-in account unless `CMD_ENABLE_UPLOADS=all`; an
unrecognized value disables them. a request carries one JPEG, PNG or GIF, never
SVG. `CMD_UPLOAD_MAX_BYTES` caps one upload at 5 MiB by default, 10 MiB at
most; `CMD_UPLOAD_QUOTA_BYTES` caps the filesystem store at 512 MiB, existing
files included, and the store also stops at 10,000 files. four uploads run at
once, each within 30 seconds. each one reserves `CMD_UPLOAD_MAX_BYTES` from
hourly budgets of 20 requests and 20 MiB per account and per address and
100 MiB per instance, so the defaults allow 4 uploads per account or address
and 20 per instance an hour.

anonymous editor sessions expire after an hour. admission budgets per minute:

| what | per network address | per instance |
| --- | --- | --- |
| dynamic requests | 600 | 6,000 |
| new anonymous editor sessions | 10 | 300 |
| socket handshakes | 60 | 600 |
| revision reads | 10 | 60, two at a time |

each socket may send 150 events per second and 2 MiB per minute (counted at
two bytes per character), and all sockets together 3,000 events per second; a
socket over budget is disconnected. the editor holds at most 256 sockets: 32
per network address, 16 per account, 32 per note, across at most 64 notes.
socket limits key on the TCP peer, so all clients behind one reverse proxy
share its 32 sockets and 60 handshakes per minute. OT keeps at most 2,048
operations or 4 MiB of history; a client further behind is resynchronized and
offered its unsent text as a download.

note creation is capped per UTC day at 50 per account, 100 per address and
1,000 per instance, counted in postgres. the same whitespace-normalized
content from one account or address is refused for 60 seconds. writes to
guest-readable notes (`freely`, `editable`, `locked`) reject private keys,
GitHub tokens and AWS access key IDs before the text reaches edit history;
`limited`, `protected` and `private` notes are not checked. a frontmatter
header over 8 KiB or 16 levels deep, or one using YAML anchors, is ignored
whole, so the note loses its tags and `approved-by` and a spec drops off the
board.

with `CMD_SPEC_BOARD_URL` set, the editor applies the board's moderation: a
hidden note cannot be read, and a suspended GitHub account cannot write,
create notes or upload. its database role needs `SELECT` on
`spec_board_moderation_notes`, `spec_board_moderation_accounts` and
`spec_board_moderation_uploads`, which the board's migration job grants
through `EDITOR_DB_ROLE`. if those tables cannot be read, note content is
refused while health checks and migrations keep working. open sockets
recheck every two seconds and disconnect when a check fails or is more than
five seconds old. without `CMD_SPEC_BOARD_URL` the editor never queries these
tables.

local attachments are served with `Cache-Control: no-store`, encoded or
normalized aliases of a path are refused, and with a board configured each
filename is checked against its moderation state first. moderators block and
restore an attachment by filename. copies already downloaded or held by an
external image provider need their own takedown.

notes cannot add global CSS or arbitrary frames. the default CSP loads images
and media only from the editor's origin (plus `data:` images), so remote
images and YouTube, Vimeo and Gist embeds do not load. it also blocks PDF
objects and lets only this origin frame the editor (`CMD_CSP_ALLOW_PDF_EMBED`
and `CMD_CSP_ALLOW_FRAMING` default to `false`). mermaid renders in an opaque
sandboxed frame, at most 8 diagrams of up to 8,192 characters and 64 edges
each. katex renders at most 64 formulas of up to 4,096 characters each, with
`trust` off. reveal's speaker view is left out of the built assets: in
reveal.js 3.9.2 it accepts `postMessage` content from any origin, an XSS
([GHSA-hhqj-cfjx-vj25](https://github.com/advisories/GHSA-hhqj-cfjx-vj25)).

approval roles list numeric GitHub IDs; their login labels are display only.

sign-in reads the provider profile and discards the oauth tokens. the one
exception is the gitlab access token (never its refresh token), because
snippet import and export call the gitlab API later: with
`CMD_OAUTH_TOKEN_KEY` (64 hex characters) set, it is kept, AES-256-GCM
encrypted and bound to the provider, subject and account. without the key,
gitlab sign-in works and snippets are off. a migration clears any plaintext
tokens already stored, and a changed key leaves stored tokens unreadable;
either way gitlab users sign in again to use snippets.
