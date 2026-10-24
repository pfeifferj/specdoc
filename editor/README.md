# editor

container image of hedgedoc 1.x with criticmarkup review: inline comment
threads with replies, suggestions with accept/reject, spec approvals in the
navbar. drop-in for the official `hedgedoc/hedgedoc` image: same `CMD_*` env
config, port 3000, postgres-ready.

## why it rebases

the review features started in the
[bexelbie criticmarkup fork](https://github.com/bexelbie/hedgedoc). SpecDoc
carries those changes and its own patches on an upstream release. Two files
define the editor source:

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

- build and runtime images use Node 24.22.1 LTS. Rebuild the source image when
  changing Node so native dependencies match the runtime.
- the patch ledger is `FORK.md` on the `critic` branch, not in this tree.

## security limits

Uploads require sign-in and accept raster images only. `CMD_UPLOAD_MAX_BYTES`
defaults to 5 MiB (maximum 10 MiB); `CMD_UPLOAD_QUOTA_BYTES` defaults to 512 MiB
for the filesystem provider, including existing files. The store also stops at
10,000 files. Uploads have four concurrent slots, a 30-second deadline and
hourly account/address and aggregate byte budgets. SVG uploads are refused.

New anonymous editor sessions expire after an hour. Dynamic requests, revision
reads and socket handshakes/events have admission limits. There are at most
256 sockets, 32 per network address, 16 per account, 32 per note and 64 active
notes. A reverse proxy shares its socket address limit across the clients it
forwards. OT retains at most 2,048 operations or 4 MiB and resynchronizes older
clients, offering their unsent text as a download.

Creation allowances persist in PostgreSQL: 50 notes per account, 100 per
address and 1,000 globally per UTC day. Repeated normalized content from the
same account/address is refused for 60 seconds. Public writes reject clear
private-key, GitHub token and AWS access-key patterns before saving history.
Frontmatter is limited to 8 KiB and 16 levels, with YAML anchors disabled.

With `CMD_SPEC_BOARD_URL`, reads and writes enforce the board's hidden-note
and suspended-account decisions. The editor needs read access to the three
board moderation tables; unavailable policy denies content access while health
and migrations remain available. Existing sockets refresh authorization every
two seconds and stop on expiry or denial. Standalone editors without a board
do not need these tables.

Local attachments check the board's per-filename moderation state before
static serving, refuse alternate encoded paths, and use `Cache-Control:
no-store`. Moderators can block and restore copied attachment URLs. Files
already downloaded and external image-provider copies require separate takedown.

Note CSS and arbitrary frames are removed. Default CSP allows local media,
disables PDF objects and limits framing to this origin. Mermaid runs in an
opaque sandbox; KaTeX renders bounded math with trust disabled. The unsupported
Reveal speaker-view plugin is omitted from built assets. Approval roles use
numeric GitHub IDs, with optional login labels. Sign-in tokens are discarded
after profile lookup. The optional GitLab snippet integration requires a
separately supplied 64-hex-character `CMD_OAUTH_TOKEN_KEY` to encrypt retained
access tokens with AES-256-GCM and account binding; without it, login works and
snippets are disabled. The migration purges existing plaintext credentials;
GitLab users sign in again to use snippets. Key rotation requires another sign-in.
See the fork's `FORK.md` for the complete limits and migrations.
