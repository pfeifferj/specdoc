# changelog

## unreleased

- Show invalid specification relationships on cards and read APIs, withholding
  publication until corrected while retaining approval credit.
- Keep advisory consistency findings for dependency and replacement pairs
  instead of treating a declared relationship as a resolution.
- Preview local specification change bundles with exact source diffs, explicit
  obligation transfers and structural capability, relation and rule diagnostics.
- Trace ordinary `Spec:` contributions separately from `implements` completion,
  using explicit source mappings and reporting unresolved identities.
- Expose bounded local build, test and CI declarations through CLI and MCP,
  retaining exact source evidence and omissions without executing checks.
- Pin task requirements from explicit local Git sources and reuse their exact
  revisions, blobs and hashes across resumes and agent handoffs.
- Return structured context authority, freshness, complete sections, receipts,
  omissions and gaps through CLI and MCP, with opt-in completeness enforcement.
- Style CLI browser authorization, confirmation and error pages consistently
  with SpecDoc, with optional deployment themes through `CMD_THEME_DIR`.
- Add the installable `specdoc` CLI for public specs, guarded author edits,
  bot reviews, and code context, with offline help and structured output.
- Add browser device login that authenticates local or remote terminals,
  expiring tokens, OS-keyring or explicit private-file storage, and token status
  and revocation.
- Check deployed browser-login support before touching credential storage;
  explain missing server routes and preserve HTTP errors from HTML responses.
- Add durable public operation receipts and bounded retries, preserving
  original edit guards and preventing duplicate writes after lost responses.
- Share clients and context implementations between the CLI and MCP while
  keeping remote CLI commands independent of repository indexing.

- Support deployment-owned themes, display names and old-host redirects.
- Default the MCP client to localhost; configure SPECDOC_URL for a hosted board.

- Collect and save verified GitHub emails at sign-in, prefer the primary address,
  and wait for missing commit emails before publishing author and reviewer credits.
- Honor commenters' commit-author email preferences separately from notification
  delivery settings and keep display names separate from GitHub logins.
- Keep comment and suggestion cards above the editor in split view, with their
  controls reachable while scrolling or resizing the preview.
- Include the frontmatter repair helper in the board image and build that image
  in CI so missing runtime files fail before deployment.
- Prevent the comment and suggestion tools from inserting review markup in YAML
  headers or before their opening delimiter, which could hide specs from the board.
- Automatically repair existing specs with comments before the YAML header during
  an editor upgrade, preserving comment text, attribution and note permissions.
- Keep affected specs visible on the board before the editor repair runs, while
  continuing to count their open review comments as publication blockers.
