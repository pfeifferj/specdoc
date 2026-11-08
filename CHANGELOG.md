# changelog

## unreleased

### changes

- Bots can configure JSON format, reasoning effort, temperature, the token-limit
  parameter and a full completion URL. Existing request defaults are preserved.
  Malformed or incomplete model output fails without creating findings.
  Changing a bot's endpoint URL or URL type clears its saved API key unless a
  replacement is supplied.
- Checkpoint overlap checks and summaries refresh after bot configuration changes.
  Analyses that select one bot now choose consistently by name.
- Projects can enable documentation follow-ups for merged implementation PRs.
  SpecDoc proposes updates to selected Markdown files and links the docs PR
  from the source PR for the author's review.
- Feedback retention works with restricted database roles. `/statusz` returns
  503 while a feedback task is failing.
- Privileged database functions ignore caller-created temporary types.
- Optional PR intake posts a SpecDoc proposal link and closes outside PRs.
  Active organization members and the configured App bot are exempt.
  Intake repositories require App authentication for publication.
- Projects can enable automatic merging of SpecDoc publication PRs after their
  configured checks pass. The board verifies the approved document and current
  review state before merging. A newly approved change can replace its initial
  PR while that PR is still unmerged.
- The editor's Discussion panel supports general threads, replies, resolution
  and approval history. Open threads block publication.
- Cross-spec conflicts and overlaps share one Discussion thread on both specs,
  with quoted requirements and saved source text. Open threads block publication
  of either spec and checkpoints that include it. Resolving one clears both
  blocks; repeated model findings preserve that decision.
- Failed review saves retry the original response without extra model calls or
  duplicate comments. Delivery progress survives restarts.
- History shows saved revisions and their diffs inside the editor. Unsaved
  discussion drafts survive panel switches and failed requests.
- Contributors can generate a proposed-change summary from the diff and
  discussion. Summaries remain advisory and use only recorded reasons.
- Pending approvers receive a reminder after 24 hours, once per review version.
  `REVIEW_REMINDER_HOURS=0` disables reminders.
- Upgrade the editor and board together, and run the board database migration
  before starting the new board. Migration and startup require
  `SPECDOC_SECRET_KEY` when model credentials are stored.
- An approval stops counting when the note's text, title, project, area, kind,
  `depends-on` or `supersedes` changes, or when the project's `roles.yml`
  changes. Approvals given before the upgrade no longer count.
- Only notes whose owner's GitHub account is listed under `authors` or
  `approvers` in `roles.yml` can be approved, published, reviewed by bots or
  trigger mail. Notes that guests cannot read (`limited`, `protected`,
  `private`) are never approved or published.
- A `supersedes` retires the old spec only once the replacement's PR has
  merged. Specs retired before the upgrade show on the board again, because
  their retirement has no verified merge record. Admins can reverse a
  retirement by posting a reason to `/admin/specs/NOTE_ID/unretire`.
- Invalid `depends-on` and `supersedes` values, such as an unquoted `#N`,
  duplicates, self-references or a `supersedes` naming a spec in another
  project, show on cards, in the read APIs and as checkpoint blockers, and
  block publication until fixed.
- Checkpoint overlap findings include specs linked by `depends-on` or
  `supersedes`; a declared relation no longer hides a conflict.
- Existing board sessions end on upgrade. Sessions last 8 hours instead of 30
  days, admin and moderator actions need a sign-in within the last hour, and
  sign-in requires `SPEC_BOARD_BASE_URL` and refuses requests for other hosts.
  Existing editor sessions need a new sign-in before using administrator
  overrides in discussions.
- Signed-in readers can report a card. Admins and the accounts listed in
  `BOARD_MODERATOR_IDS` handle reports at `/moderation`, where they can hide
  notes, suspend accounts and block uploaded files; the editor enforces these
  decisions.
- The editor refuses edits that put a private key, GitHub token or AWS access
  key into a public note, and the board neither publishes such text nor sends
  it to review bots.
- Review bots call only HTTPS endpoints that resolve to public addresses.
  Model calls, failed ones included, are capped per day at 100 in total and 25
  per project (`MODEL_DAILY_CALLS`, `MODEL_PROJECT_DAILY_CALLS`) and at
  2,000,000 and 500,000 tokens (`MODEL_DAILY_TOKENS`,
  `MODEL_PROJECT_DAILY_TOKENS`). `MODEL_AUTOMATION_DISABLED=true` stops them.
- Digests go only to email addresses verified on the recipient's GitHub
  account. Digests queued before the upgrade are dropped, and unsubscribe links
  in earlier mail return 400. `NOTIFICATIONS_PAUSED=true` stops queueing and
  sending. Webhook posts no longer trigger @mentions and are capped at 20 a
  minute.
- Daily and weekly digests retain queued events long enough to become due,
  including during continued activity. Expired events are never sent.
- `/healthz` and anonymous `/statusz` return only `ok`; `/statusz` details need
  an admin session or a `MONITORING_TOKEN` bearer token of at least 32
  characters. Board responses deny framing and, with an HTTPS
  `SPEC_BOARD_BASE_URL`, set HSTS for a year.
- Add `node maintenance.js redact-history`, which erases a note's earlier text
  from editor revisions and the board's stored copies while both services are
  stopped. It keeps hashes and audit records, makes the note private and
  hidden, and only previews without `--apply`.
- A bot token alone no longer enables the MCP bot tools (`read_note`,
  `comment`, `suggest_edit`, `reply`): they also need
  `SPECDOC_ALLOW_WRITES=true` and the note IDs in `SPECDOC_WRITE_NOTES`, and act
  only on those notes. MCP reads stay inside the configured repository and the
  directories in `SPECDOC_ALLOWED_ROOTS`, and refuse symlinked paths, object
  alternates and Git config with includes or filters. `--out` writes only new
  files inside those directories.
- Node 24.22.1 replaces Node 20 in the board and editor images; the `specdoc`
  CLI needs Node 22 or newer. Editor advisories that remain open, and the
  optional integrations they affect, are listed in
  [dependency advisories](docs/dependency-security.md).
- The editor's default CSP loads images, media and frames only from the editor
  itself, so remote images, GitHub avatars and YouTube, Vimeo and Gist embeds no
  longer show. PDF embeds are off, and other sites can frame the editor only
  with `CMD_CSP_ALLOW_FRAMING=true`. Notes lose `<style>`, `style` attributes
  and `<iframe>`. KaTeX replaces MathJax, and the Reveal speaker view is gone.
- Uploads to the editor need sign-in unless `CMD_ENABLE_UPLOADS=all`, refuse
  SVG and take one image of up to 5 MiB (`CMD_UPLOAD_MAX_BYTES`). The
  filesystem store stops accepting files at 512 MiB (`CMD_UPLOAD_QUOTA_BYTES`)
  or 10,000 files, counting existing ones. The editor accepts 256 live
  connections, 32 per network address (clients behind one reverse proxy share
  one) and 32 per note; see [security limits](editor/README.md#security-limits).
- YAML frontmatter larger than 8 KiB is ignored by the editor and the board.
- The editor no longer keeps sign-in OAuth tokens and deletes stored ones on
  upgrade; GitLab snippets need `CMD_OAUTH_TOKEN_KEY` and a new GitLab sign-in.
- Add `specdoc context preview` and the MCP `preview` tool, which show the
  diffs in a local spec change bundle and check its declared requirement
  transfers and relations without contacting the board.
- Add `specdoc context build` and the MCP `build` tool, which list the build,
  test and CI targets declared in Cargo, npm, Make, shell test and GitHub
  workflow files, with source lines, without running them.
- Context commands show commits with a `Spec: <path>` trailer as work toward a
  spec, separately from `implements` commits, which mark it complete; trailer
  paths that match no spec are listed as unresolved.
- Add `specdoc context pin` to record a task's requirements at fixed Git
  revisions. With `--manifest`, context commands and MCP tools read those
  revisions instead of the board, so resumed sessions and other agents see the
  same text. Pinned CLI context commands need no board URL.
- Context reports use `null` for an unknown dirty state and list uninspected
  submodules as coverage gaps, instead of reporting their checkout as clean.
- `context query` and the MCP `context` tool report where each section came
  from, when the board was read and what was omitted or missing;
  `--require-complete` fails when a pinned manifest's required context is
  incomplete.
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
