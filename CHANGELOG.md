# changelog

## unreleased

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
