# SpecDoc CLI architecture: repository evidence, guarded writes, and authentication

Research date: **2026-10-20**. Repository HEAD observed: `3fa853742f5df5572cbe4ef9cc7a9759dcaa979a`. These findings describe the **working tree**, not a verified deployment. Pre-existing changes include `docs/api.md`, `docs/context-graph.md`, `mcp/server.js`, `mcp/specs.js`, `mcp/package.json`, `spec-board/server.js`, and `editor/critic.bundle`. The clean `editor/.work` checkout is at `33d13352a73dca8210e911e2431b21cc0fa5f8e0`, matching the bundle's `critic` ref; its source is recoverable from the bundle, as documented in [A0: editor/README.md:17](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/README.md:17). No credentials, production writes, or running deployment were inspected. Local references below were read on this date; external references were retrieved on this date.

## 1. Which existing interfaces should the CLI expose?

### Takeaway

Expose public spec reads, personal note editing, and bot review as three explicit capabilities. A CLI can already wrap HTTP for all three; replacing the MCP transport alone would not turn bot suggestions into direct author edits.

### Cited Findings

| Interface | Implemented/documented capability | Constraint that must survive the CLI |
|---|---|---|
| Public board `/api/specs` | Paginated metadata; detail; revisions; review snapshots/diffs. | Public notes only; metadata has snapshot age/staleness; detail `body` strips frontmatter and resolves CriticMarkup. It is publication-ready text, not necessarily an already published revision. [A1: docs/api.md:18](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:18), [A1:68](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:68) |
| Editor `/api/v1/notes` | PAT-authenticated raw GET, create POST, complete-content PUT. | User permissions, `notes:read`/`notes:write`, exact ETag, no active editor. Saved database text can lag an open editor. [A2: docs/api.md:179](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:179), [A3: editor/.work/lib/web/apiRouter.js:89](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/web/apiRouter.js:89) |
| Board `/api/bot/notes` | Raw content/hash/thread GET; comment, suggestion, reply POST. | Enabled bot identity, configured namespaces, public notes; no arbitrary replacement operation. [A4: spec-board/server.js:3514](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3514) |
| Internal editor `/internal/spec-board/v1/mutate` | Server-to-server review and permission mutations, durable operation receipts. | HMAC assertion and shared deployment secret. This is privileged backend infrastructure, not a fourth agent credential. [A5: spec-board/editor-client.js:5](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/editor-client.js:5), [A6: editor/.work/lib/spec-board-api.js:16](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/spec-board-api.js:16) |

- There is already a shell interface: `node mcp/server.js <tool> ...` invokes read/context tools. It constructs and refreshes `Context`, which indexes the checkout, reads Git history, and loads the board corpus. Tree-sitter loads at module import. Unknown first arguments fall through to MCP serving rather than a normal CLI usage error. [A7: mcp/server.js:444](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/server.js:444), [A7:39](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/server.js:39), [A8: mcp/index.js:1](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/index.js:1)
- MCP write registration exposes only bot operations. Its raw read deliberately clips content to a token budget, making that rendered output unsuitable as the base for replacing a whole note. [A7:405](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/server.js:405)
- Existing identity resolution distinguishes note IDs from `owner/repo#N`; `N` is indexed from the board's PR number. Editor lookup accepts alias, UUID, encoded UUID, or shortid and gives aliases precedence. It does not infer identity from a title such as `SPEC-006`. [A9: mcp/specs.js:93](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/specs.js:93), [A10: editor/.work/lib/note-api.js:35](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:35)

### Inferences

- **Proposed package boundaries:** a small transport client containing separate `BoardClient`, `EditorClient`, and `BotClient`; a service layer for identity normalization, raw edit preparation, guard handling and structured results; CLI and optional MCP adapters over that layer. Keep code-context indexing behind a separate lazy-loaded module/command. These boundaries follow the three existing HTTP contracts and the current eager context initialization. [A1–A4, A7–A9]
- Profiles should configure `board_url`, `editor_url`, and explicitly trusted origins independently. Bind an editor token to its editor origin and a bot token to its board origin. A pasted document URL selects an ID only after validating its origin and supported path; never send a token to an arbitrary pasted host or accept redirects silently. RFC 6750 requires protecting bearer tokens and validating their resource server. [A11: RFC 6750 §5.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-5.3)
- For `https://md.josie.cloud/bR0-jQzDTtiBkdjuywpYEg`, preserve the path identifier; do not turn `SPEC-006` into `#6`. Resolve through the editor for editing, and return canonical ID plus URL. Support board references separately, resolving them through board metadata. Preserve fragments as optional anchors, not identifiers. [A9, A10]
- Start with Node because existing clients, reference parsing, schemas and tests are JavaScript; extract their reusable pieces rather than shelling out to the existing server. Remote CRUD must run outside Git and without tree-sitter. A Go/Rust rewrite could change distribution/runtime requirements, but there is no measured startup or packaging comparison here to justify its duplication cost. [A7–A9, A12: mcp/package.json:1](/home/josie/rh-src/netfyr-ecosystem/specdoc/mcp/package.json:1)

### Gaps

- Production version, API reachability, and account permissions remain unverified. Source presence is not deployment confirmation.
- A current read API does not report authenticated identity, token scope/expiry, or effective write capability. Its router contains only note GET/POST/PUT. `auth status` can identify configured credential type locally, but must not claim validated write permission from a successful GET. Add a minimal authenticated capabilities endpoint. [A3]

## 2. How should document writes, conflicts, and uncertain outcomes work?

### Takeaway

Use full raw source and the guard returned with that source. Separate stale text, a busy editor, review lifecycle restrictions, and an uncertain network outcome; none is solved by blindly refreshing a guard and retrying.

### Cited Findings

- Editor ETags hash a representation containing note identity, alias, title, content, permission, owner and timestamp. They are **not** the board's SHA-256 content hash. PUT first reserves the note, then checks exact ETag, and transactionally compares persisted identity/permission/timestamps/content before updating. Missing guard is 428, stale guard 412, occupied editor/save/update 409. `If-Match: *` is not accepted as a substitute. [A10:66](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:66), [A10:161](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:161), [A2:251](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:251)
- PAT updates preserve authorship on unchanged spans and attribute inserted text to the token owner. Internal review mutations pass a null author for inserted text. The board identifies bot contributions through their review signatures; bot text does not become approval credit. [A10:72](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:72), [A6:104](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/spec-board-api.js:104), [A13: docs/context-graph.md:227](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/context-graph.md:227)
- Bot suggestions may reopen approved/implemented specs. Comments and replies are refused on approved specs. Missing suggestion anchors become comments, not the requested substitution; results expose `placed`/`unanchored`. Direct PAT PUT has no equivalent automatic review retagging. Lifecycle documentation explicitly instructs an author revising an approved spec to move it back to `in-review`. [A4:3389](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3389), [A4:3535](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3535), [A10:175](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:175), [A14: docs/spec-lifecycle.md:208](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/spec-lifecycle.md:208)
- **Documentation contradiction:** `docs/api.md:171` says repeated writes already present return `written:false`. Comments and suggestions do content-based deduplication, but `appendReply` always appends. A retry with its old hash conflicts; repeating a reply after fetching a fresh hash can duplicate it. Content deduplication also cannot establish whether a removed/resolved suggestion was previously applied. [A1:171](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:171), [A4:3293](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3293), [A4:3358](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3358), [A4:3463](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3463)
- Internal mutation receipts bind an `operationId` to a request hash and persist the result. However, each public bot write generates a new random operation ID; external callers cannot supply or query it. PAT create generates a fresh note UUID and has no request receipt contract. [A6:60](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/spec-board-api.js:60), [A6:130](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/spec-board-api.js:130), [A4:3439](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3439), [A10:121](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/note-api.js:121)
- HTTP `If-Match` is designed to prevent lost updates; HTTP idempotence describes repeated intended effects, not guaranteed knowledge that a timed-out operation failed. [A15: RFC 9110 §§9.2.2, 13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)

### Inferences

Proposed direct-author flow, with command names illustrative:

```sh
specdoc auth status --editor https://md.josie.cloud --json
specdoc note checkout https://md.josie.cloud/bR0-jQzDTtiBkdjuywpYEg \
  --output spec.md --state spec.state.json
# Edit complete raw spec.md, preserving frontmatter and unrelated review markup.
specdoc note diff --state spec.state.json --file spec.md
specdoc note update --state spec.state.json --file spec.md --json
```

The state artifact should contain canonical origin/identity, exact quoted ETag, original source/digest, representation type `raw`, and retrieval time; never a credential. Validate that state and content are complete and belong to the selected target. Preview may be local and must not claim reservation. Update sends `{content}` plus the original `If-Match`; it does not automatically reacquire a newer ETag. A known successful response returns canonical identity and new guard; report publication as separate, asynchronous state. [A2, A3, A10, A14]

Proposed review flow uses `specdoc review read ID --output review.json`, followed by `review suggest --state review.json --file suggestions.json`. Preserve the raw hash; report unanchored suggestions explicitly. Do not silently switch between PAT author editing and bot suggestions because one credential is unavailable. [A4, A13]

On 412, fetch current text for reconciliation; on 409, explain the busy-editor or lifecycle restriction and preserve pending work. After connection loss during a write, emit `outcome: unknown` and retain the target, before-guard and desired digest. For PUT, a subsequent GET can establish that the desired content currently exists, but cannot prove which request authored it. Never automatically repeat POST creation or reply after refreshing the guard. [A4, A10, A15]

### Gaps

- Add public idempotency receipts for create/review writes: actor+endpoint+operation key, body fingerprint, durable result, changed-payload rejection and a documented retention window. The internal receipt mechanism is precedent, not present public support. [A6]
- Add structured backend reason codes: bot API currently collapses editor 409 and 412 into one message. Clarify reply deduplication docs and supply a genuinely strict anchoring option if agents need “all substitutions placed or nothing written.” [A4:3543](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3543)
- Acceptance checks should cover stale and missing guards, open tabs, permissions changing mid-write, attribution, CRLF normalization, preservation of review markup, approved-note transitions, dropped responses, duplicate reply retries, and URL/title/PR-number confusion. Local tests exist for bot stale guards and busy notes, but were inspected rather than executed here. [A16: spec-board/bot-api-db-test.js:81](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/bot-api-db-test.js:81)

## 3. How does browser login fit the existing authorization model?

### Takeaway

Make `specdoc auth login` print a browser URL, wait for authorization, and receive a SpecDoc credential automatically. Existing provider login and PAT issuance supply useful building blocks, but the browser-to-CLI authorization bridge is new backend work.

### Cited Findings

- The editor already supports provider login with Passport. Its GitHub callback uses state and PKCE, then returns to the editor; generic OAuth2 is also a configured provider. These are upstream identity-provider flows, not an authorization server endpoint for native SpecDoc clients. [A17: editor/.work/lib/web/auth/github/index.js:12](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/web/auth/github/index.js:12), [A18: editor/.work/lib/web/auth/oauth2/index.js:133](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/web/auth/oauth2/index.js:133)
- `/me/tokens` requires the actual Passport session and CSRF token. It issues read or read+write PATs, displays the secret once, and supports revocation. Tokens are randomly generated, hash-stored, expire in 1–365 days (default 30), and are checked for revocation/expiry on each API request. [A19: editor/.work/lib/web/tokenRouter.js:21](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/web/tokenRouter.js:21), [A20: editor/.work/lib/personal-access-token.js:19](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/personal-access-token.js:19)
- Tokens cannot authorize review approvals or mint more tokens. PAT scope is read/write across the owner's permitted notes, not a namespace-limited delegation. Bot scope is a separate project list. [A2:188](/home/josie/rh-src/netfyr-ecosystem/specdoc/docs/api.md:188), [A20:24](/home/josie/rh-src/netfyr-ecosystem/specdoc/editor/.work/lib/personal-access-token.js:24), [A4:3454](/home/josie/rh-src/netfyr-ecosystem/specdoc/spec-board/server.js:3454)
- Native-app OAuth guidance specifies an external browser, loopback redirect support and PKCE; device authorization provides a browser verification URL/code with polling for environments where a callback cannot reach the CLI. [A21: RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [A22: RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html)
- GitHub CLI provides a practical credential-storage precedent: system credential store, disclosed plaintext fallback, stdin token import and environment credentials for automation. [A23: gh auth login](https://cli.github.com/manual/gh_auth_login)

### Inferences

Propose a small editor-owned authorization service with four responsibilities: create a pending authorization, show authenticated consent, exchange an authorization code, and report/revoke the resulting CLI session. Reuse the editor's user identity and existing scope enforcement. Do not forward a GitHub access token, browser session cookie, or internal board secret to the CLI. A SpecDoc browser session can satisfy sign-in without reauthenticating, but it must still show the selected account, destination CLI and requested permissions. [A17–A20]

For local use, `auth login` starts a listener on a loopback IP and ephemeral port, generates state and an S256 PKCE challenge, and prints the authorization URL. The editor retains the pending request across provider sign-in, then issues a short-lived, single-use code bound to client, redirect, scopes and challenge. The browser redirects **the code**, not the PAT, to the waiting process. The CLI validates state and exchanges code+verifier over HTTPS. Close the listener on success, denial, timeout or interruption. No embedded browser or packaged client secret is needed. [A21, A11]

For SSH/containers, `auth login --device` should print a verification URL/code and wait using the server's polling interval. Model expiry, denial, `authorization_pending` and `slow_down` explicitly. Device polling avoids assuming that browser localhost is the remote CLI host. This is additional server functionality, not a URL flag on today's PAT page. [A22]

An incremental bridge can issue the existing revocable, expiring PAT after successful code exchange; that reuses current permission checks but still produces a relatively long-lived credential. A future short-lived access-token/rotating-refresh-token design needs additional grant storage and replay/revocation policy. Do not claim that current PATs implement refresh. Default to OS keyring storage; support environment/stdin for automation and an explicitly selected restricted-permission file fallback. Disclose storage mode in `auth status` without printing secrets. [A20, A23]

Ordinary read/write commands should never launch a login interaction unexpectedly. Missing editor authorization should return a stable error with `required_capability: notes:write`, the selected editor origin and the exact `auth login` command. Distinguish “configured but unverified,” “expired/revoked,” “insufficient scope,” and “note inaccessible.” A successful login should report granted scopes/expiry; browser approval is not spec-review approval. [A2, A3, A20]

### Gaps

- Pending authorizations, code exchange, device flow, credential introspection and CLI revocation endpoints do not appear in the inspected routers. Provider callbacks need a safe route back to a pending consent request; do not accept arbitrary return URLs. [A3, A17–A19]
- Required auth acceptance checks: wrong state/verifier/redirect, reused/expired code, consent denial, account switching, SSH device completion, cancellation, token revocation, wrong-origin URLs/redirects, and keyring failure without silent secret exposure. These are proposed requirements, not claims of present implementation. [A11, A21–A23]
