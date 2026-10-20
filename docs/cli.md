# SpecDoc CLI

`specdoc` reads specs, edits complete Markdown notes, contributes bot reviews,
and retrieves code context. It runs on Node 20 or newer. MCP uses the same
clients and context implementation for hosts that need a tool adapter.

## install and sign in

Build an installable package from this checkout:

```sh
cd cli
npm ci
npm pack
npm install --global ./specdoc-cli-0.1.0.tgz
```

Configure your instance and authorize the terminal:

The editor must already have the CLI server update deployed. Installing this
package only installs the client. Browser login checks
`https://YOUR_EDITOR/.well-known/specdoc` for device authorization support;
an HTML 404 means the route is unavailable. Deploy the updated editor before
retrying login. The board update is also needed for durable bot receipts.

```sh
specdoc auth login \
  --editor-url https://md.example.com \
  --board-url https://specs.example.com
```

The terminal prints a verification link and a short code. Open the link,
sign in to SpecDoc, check the account, code and requested access, and approve.
The waiting terminal saves its credential automatically. This also works
over SSH: the browser can run on a different machine. `--open-browser` asks
the CLI to open the link for you.

Login grants read/write access for 30 days by default. Use `--read-only` or
`--expires-in-days 7` to reduce that access. There is no refresh token; sign in
again after expiry. Existing login credentials are preserved if a replacement
login is denied, interrupted or cannot be stored.

The default credential store is the OS keyring. Linux requires a running,
unlocked Secret Service. Use `--storage file` explicitly on machines without
a keyring; credentials then use private directories and `0600` files. There is
no silent file fallback. Native keyring and code-indexing dependencies are
optional: installing with `--omit=optional` still supports remote commands
and file-based credential storage.

```sh
specdoc auth status --format json
specdoc auth status --offline --format json
specdoc auth logout
```

Normal status checks the credential with the editor. Offline status reports
local presence without claiming the server accepts it. Logout attempts server
revocation and removes the active stored credential, reporting the two outcomes
separately. If stdin or the environment supplies the active credential, logout
revokes that credential and retains any separate saved login. `--local-only`
skips server revocation. Environment variables remain in the calling shell
until you unset them.

## read and edit

```sh
specdoc spec list --namespace owner/repo --limit 20 \
  --fields id,title,url,status --format json
specdoc spec get NOTE_ID --format markdown
specdoc note checkout https://md.example.com/NOTE_ID --output spec.md
```

`spec get` reads the board's publication-ready representation.
`note checkout` reads complete raw source, including YAML frontmatter and
review markup. It writes `spec.md` and `spec.md.specdoc.json`, refusing to
overwrite either. The state file contains the original source and exact
editor ETag; treat it as private note content.

Edit the Markdown, then preview and submit:

```sh
specdoc note diff --state spec.md.specdoc.json --body-file spec.md
specdoc note update --state spec.md.specdoc.json --body-file spec.md --format json
specdoc note create --body-file new-spec.md --format json
```

Update keeps the original guard. A changed note requires a fresh checkout
and reconciliation; the CLI does not overwrite concurrent edits. An open
editor can temporarily block writes, including your own browser tab.
Line endings are normalized to LF, matching the editor API. A missing final
newline is preserved. After a successful update, obtain a fresh checkout
before making another edit.

Editing as a user and suggesting changes as a bot are different operations.
Author updates retain the editor's permission and lifecycle rules; changing an
approved spec requires the normal return-to-review workflow.

## bot reviews

Bot tokens belong to the board, independently of the editor login. Set both
`SPECDOC_BOT_TOKEN` and its matching `SPECDOC_BOARD_URL` in your automation
environment. The CLI never sends an editor token to the board.

```sh
specdoc review get NOTE_ID --format json
specdoc review suggest NOTE_ID --expected-hash HASH_FROM_REVIEW_GET \
  --body-file suggestions.json --format json
specdoc review reply NOTE_ID --expected-hash HASH_FROM_REVIEW_GET \
  --thread THREAD_ID --body-file reply.txt --format json
```

Suggestion files contain an array of `{quote, replacement, rationale}` objects;
comment files contain `{quote?, text}` objects. Replies take plain text.
The server may leave an unmatched suggestion as a comment, so inspect the
returned `placed` and `unanchored` counts. Suggested text is not automatically
accepted.

## recovery and automation

The CLI records an operation key before each write. On servers advertising
durable receipts, bounded retries reuse that key, payload and original guard.
A lost response may leave an unknown result:

```sh
specdoc operation get OPERATION_KEY --identity author --format json
specdoc operation get OPERATION_KEY --identity bot --format json
```

Recover that operation before issuing another write. A new key is a new
operation. Receipts retain results for seven days; their non-content key
records remain afterward so an expired key cannot execute again. Recovery
still requires current authorization. Bot receipts belong to the issuing bot
credential, so rotation prevents recovery with its replacement token.

For agents and scripts:

- Use `--format json` for a versioned result on stdout. Structured errors go
  to stderr. Exit codes are `0` success, `2` usage, `1` operational failure,
  and `130` interruption.
- Use `--body-file -` to read stdin explicitly. `--token-stdin` supplies a
  credential without placing it in argv; it cannot share stdin with a body.
- Commands and flags use exact spellings. Ordinary commands never open an
  editor/browser, prompt for input, or start a pager.
- `auth login --non-interactive` requires `--token-stdin`; it fails before
  starting browser authorization if no token is supplied.
- Lists default to 20 items and return continuation/completeness metadata.
  Pass `--cursor` to fetch another page; `--fields` does not discard that
  metadata.
- Help and schemas work offline: `specdoc note update --help` and
  `specdoc schema note.update --format json`.

Configuration lives under `$SPECDOC_CONFIG_DIR`, or
`$XDG_CONFIG_HOME/specdoc` (default `~/.config/specdoc`). Use `--profile`
to select an instance. Explicit URL flags override `SPECDOC_EDITOR_URL` and
`SPECDOC_BOARD_URL`, which override the saved profile. Profiles keep both
service URLs; subdomains are never guessed.

Automation can use `SPECDOC_TOKEN` together with its matching
`SPECDOC_EDITOR_URL`, or a bot token with its matching board URL. Stdin
credentials override environment credentials, which override stored credentials.
Document URLs must belong to the configured services. Display titles such as
`SPEC-006` are not identifiers; `owner/repo#N` refers to a board PR number.

## code context

```sh
specdoc context query 'implement route reconciliation' \
  --repo /path/to/checkout --namespace owner/repo
specdoc context trace spec:owner/repo#7 --repo /path/to/checkout
specdoc context brief --repo /path/to/checkout
```

Context commands load the optional indexing dependencies and inspect the
checkout. They retain the existing context budgets, source provenance and
receipt behavior described in [context graph](context-graph.md). Ordinary
remote commands do not index a checkout.

The [API reference](api.md) describes write guards, device authorization and
receipt protocols. Older deployments can still support existing PAT-based
commands; browser login and automatic write retries require the corresponding
server capabilities.
