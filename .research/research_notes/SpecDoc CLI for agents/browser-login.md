# Browser login for a SpecDoc CLI

Retrieved **2026-10-20**. This note compares documented Codex and Claude Code behavior with native-app authorization standards. It proposes a SpecDoc interaction contract; no login was started and no credential files were opened.

Local inspection preceded OpenAI web fallback: `/home/josie/.local/bin/codex` resolves to the packaged **0.163.0** executable; its installed directory contains binaries and metadata, not the Rust login source. `codex login --help` confirms `--device-auth` and stdin credential options. `claude auth login --help` confirms account-selection options. These help commands establish available interfaces, not OAuth implementation details. Current official documentation was then retrieved; it is a living reference and may describe versions beyond the locally installed builds.

## What do Codex and Claude Code actually do?

### Takeaway

Both document a browser login that can return automatically through a local callback. Codex additionally documents device-code authentication for headless environments; Claude Code documents a manual code-paste fallback when its local callback is unreachable.

### Cited Findings

| Behavior | Codex | Claude Code | Evidence scope |
|---|---|---|---|
| Entry point | `codex login` opens a browser for ChatGPT OAuth | First interactive launch opens a browser; `claude auth login` is also available | [A2: Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference), [A3: Claude authentication](https://code.claude.com/docs/en/authentication), [A4: Claude CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Automatic return | Local callback, documented default `localhost:1455` | Local callback server; terminal reports successful login | [A1: Codex authentication](https://learn.chatgpt.com/docs/auth), [A3](https://code.claude.com/docs/en/authentication) |
| Remote/headless | `--device-auth`: open link, sign in, enter one-time code; documented as beta and subject to account/workspace enablement | If callback fails, browser displays a code to paste into terminal; documentation names SSH, containers and WSL2 | [A1](https://learn.chatgpt.com/docs/auth), [A3](https://code.claude.com/docs/en/authentication) |
| Alternate callback path | Documentation gives SSH forwarding for port 1455 | A copied login URL is supported when browser opening fails | [A1](https://learn.chatgpt.com/docs/auth), [A3](https://code.claude.com/docs/en/authentication) |
| Credential storage | `file`, `keyring`, `auto`, or `ephemeral`; strict keyring mode fails if unavailable, auto can fall back to file | macOS Keychain; Linux uses `.credentials.json` with mode `0600`; failed macOS login writes can fall back to that file | [A1](https://learn.chatgpt.com/docs/auth), [A3](https://code.claude.com/docs/en/authentication) |
| Automation status | `codex login status` reports mode; exits zero for stored/present credentials | `claude auth status` offers JSON and text, with exit status 0/1 | [A2](https://learn.chatgpt.com/docs/cli/reference), [A4](https://code.claude.com/docs/en/cli-reference) |
| Logout | Removes stored credentials | Provides `claude auth logout` | [A2](https://learn.chatgpt.com/docs/cli/reference), [A4](https://code.claude.com/docs/en/cli-reference) |

Claude separately documents `claude setup-token`: browser authorization prints a long-lived token and does not save it. That is a distinct automation setup interface, not the ordinary automatic login handoff. [A3](https://code.claude.com/docs/en/authentication).

### Inferences

Copy the normal interaction: present a login link, wait, store the resulting credential, then confirm the account and available access. The requested “token comes back to the terminal” should mean the CLI becomes authenticated automatically; it need not print a bearer secret into terminal scrollback or an agent transcript.

A local callback requires the browser to reach the machine running the CLI. Opening a URL on a laptop does not make the laptop's loopback interface reach a remote SSH process. The documented alternatives solve this deployment distinction in different ways.

### Gaps

The inspected product documentation does not establish exact PKCE implementation, state validation, callback-port selection algorithms, login cancellation cleanup, or all token-refresh behavior. Do not infer those from a browser opening successfully. No live flow or upstream implementation was inspected. Claude's code-paste fallback is not evidence of RFC 8628 device authorization. Stored-credential status also does not prove that a remote service currently accepts the credential.

## Which authorization architecture fits the requested experience?

### Takeaway

Use an external browser and a one-time authorization handoff. A loopback authorization-code flow fits a local terminal; device authorization fits SSH and headless agents without requiring incoming connectivity.

### Cited Findings

- **A5 — RFC 8252, October 2017, BCP 212:** native clients use an external user-agent and authorization-code flow with PKCE. Loopback callbacks may use HTTP with an IP literal and an available port; authorization servers must accommodate variable ports for registered loopback redirects. The listener should bind only to loopback and close after the authorization response. The RFC prefers loopback IP literals over `localhost`. [§§6, 7.3, 8.1, 8.3](https://www.rfc-editor.org/info/rfc8252/).
- **A6 — RFC 7636, September 2015:** the client creates a fresh high-entropy verifier; the authorization request carries its challenge, and token redemption carries the verifier. The server validates that binding. Capable clients must use `S256`, preventing an intercepted authorization code from being sufficient to redeem tokens. [§§4.1–4.6](https://www.rfc-editor.org/info/rfc7636/).
- **A7 — RFC 8628, August 2019:** device authorization returns separate device/user codes, verification URL, expiry and polling interval. An optional complete URL can avoid typing the user code, but clients still display it for verification. Polling observes `authorization_pending`, increases intervals for `slow_down`, and stops for denial/expiry; network timeouts require reduced polling frequency. [§§3.2–3.5](https://www.rfc-editor.org/info/rfc8628/).

### Inferences

**Proposed SpecDoc local flow:** `specdoc auth login` binds a temporary loopback listener, creates a fresh state value and PKCE verifier, prints the HTTPS authorization URL, and optionally launches the browser. Existing website login establishes the user. Consent identifies the instance, CLI session, requested scope and expiration. The browser redirects a short-lived, single-use authorization code to the listener; the CLI validates the response and exchanges the code plus verifier over HTTPS. It then stores the credential and prints a success summary. This follows A5/A6; it is not a claim about SpecDoc's present capabilities.

**Proposed headless flow:** `specdoc auth login --device` displays the server's verification link and user code, while the terminal polls. The user can approve from another machine, and credentials arrive over the CLI's outgoing HTTPS connection. Support a complete verification link for the requested click-and-login experience, while retaining code confirmation. This follows A7. Do not require tunneling as the ordinary remote-agent workflow.

Both flows need authorization-server support. An existing website OAuth sign-in integration does not itself make the site an authorization server for a CLI. A SpecDoc-specific grant service can reuse its user/scope model, but its protocol and lifecycle still need explicit design. The repository architecture note covers that implementation fit.

Do not place the final PAT/access token in a redirect URL. Keep long-lived credentials out of browser history, query logs, command arguments and routine output. The proposed callback carries a redeemable code bound to this CLI invocation. A native executable cannot safely rely on an embedded client secret as its proof of identity; use the public-client model in A5.

### Gaps

Neither standard dictates SpecDoc's token lifetime, scope names, refresh policy, or whether to issue a PAT versus access/refresh tokens. These are server decisions. If both flows are too much for an initial implementation, choose based on the expected local versus SSH usage and state the limitation explicitly; neither UI alone covers every deployment.

## What should the CLI guarantee and test?

### Takeaway

Bound each login invocation with an expiry, clear terminal states, safe cancellation, and a verifiable account result. Test both local and remote completion without exposing secrets.

### Cited Findings

RFC 8252 calls for closing the loopback listener after authorization. RFC 8628 supplies finite grant lifetime and explicit polling terminal states. Codex exposes credential-store policies; Claude exposes machine-readable authentication status. These provide precedents for lifecycle and operational visibility, not a complete SpecDoc implementation. [A5](https://www.rfc-editor.org/info/rfc8252/), [A7](https://www.rfc-editor.org/info/rfc8628/), [A1](https://learn.chatgpt.com/docs/auth), [A4](https://code.claude.com/docs/en/cli-reference).

### Inferences

Proposed acceptance criteria:

1. **Successful automatic return:** with an existing web session and with a fresh browser login, the waiting CLI receives authorization, stores credentials, and reports the intended instance, account, scope and expiry. Stdout JSON contains status metadata; interactive URL/instructions go to stderr. Secrets never appear in either.
2. **Headless completion:** a browser on another machine approves the device flow without port forwarding or copying a bearer token. Polling honors the server's interval and backoff. Denial and expiry produce distinct errors.
3. **Cancellation:** Ctrl+C, timeout and browser rejection stop local waiting and release listeners. Preserve any previously working credentials. Expire or invalidate the pending grant where supported; never report success after cancellation.
4. **Binding and replay:** reject wrong state, wrong verifier, expired code, reused code and mismatched instance. Concurrent terminal logins cannot consume each other's results.
5. **Storage failure:** fail clearly if the configured secure store cannot write; do not falsely report login success. Make any file-store fallback explicit, keep files private, and write atomically.
6. **Ongoing use:** `auth status --json` distinguishes missing, locally present, expired and remotely verified credentials. Show account/profile selection before an operation can use the wrong instance. Separate local logout from confirmed server revocation in results.
7. **Redaction:** exercise debug logs, HTTP errors, crash output, proxy handling and browser pages; no token, verifier or raw authorization response reaches logs or agent output.

These are proposed product requirements. They should be verified with a local authorization test fixture and disposable accounts before any production login is exercised.

### Gaps

Product-specific cancellation semantics remain unverified. The research does not justify claiming that Codex or Claude meets every proposed criterion. Testing account switching, organization policy, revoked grants and storage availability remains necessary even when the happy-path browser login works.
