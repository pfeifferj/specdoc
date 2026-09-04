# configuration

every knob both services read. [bootstrap](bootstrap.md) is the order to set
them in; this page is the reference.

## spec board

### core

| var | default | what it does |
| --- | --- | --- |
| `NAMESPACES` | empty | comma-separated allowlist of target repos (`owner/repo`). specs pointing outside it render but never open PRs |
| `DEFAULT_NAMESPACE` | first of `NAMESPACES` | namespace for specs whose frontmatter names none. must match the editor's `CMD_SPEC_DEFAULT_NAMESPACE` |
| `HEDGEDOC_BASE_URL` | `http://localhost:3000` | where the editor is, for note links |
| `SPEC_BOARD_BASE_URL` | empty | the board's own public origin. email has no request to derive it from, so unset means no email |
| `PORT` | `8080` | listen port |
| `PG*` | libpq defaults | `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; the same database the editor uses |
| `SPEC_TAG` | `spec` | frontmatter tag that marks a note as a spec |
| `POLL_SECONDS` | `60` | poll interval. one tick at a time, under a postgres advisory lock |
| `STALE_DAYS` | `14` | days without a change before a reviewing card gets a stale marker |
| `FETCH_TIMEOUT_MS` | `15000` | hard deadline on every outbound call and pg query, so a hung socket cannot wedge the poll loop |

### github

| var | default | what it does |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | unset | per-namespace installation tokens; preferred, and self-refreshing |
| `GITHUB_TOKEN` | unset | service PAT: resolves `roles.yml`, scans for `implements` commits, and backs the app up where it is not installed |
| `SPECS_DIR` | `specs` | fallback target dir for spec files. a namespace's `specs-dir` in `roles.yml` wins ([onboarding](onboarding.md)) |

without either credential the board still renders specs, but resolves no
approvers and opens no PRs.

### notifications and email

| var | default | what it does |
| --- | --- | --- |
| `WEBHOOK_URL` | unset | posts status moves, comments, approvals, locks, PRs, supersedes and implementations |
| `SMTP_HOST` | unset | enables digests, together with `SPEC_BOARD_BASE_URL` and `SESSION_SECRET` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | unset | omit for an unauthenticated relay |
| `SMTP_FROM` | `specdoc@localhost` | no-reply sender |
| `EMAIL_DEBOUNCE_MINUTES` | `30` | quiet period per recipient; each event resets it, and a burst collapses into one message |
| `EMAIL_ORG_NAME` | `SpecDoc` | sender identity in the mail footer |
| `EMAIL_POSTAL_ADDRESS` | empty | postal address in the footer, which bulk-mail rules expect |
| `PRIVACY_URL` | the board's `/privacy` | override for the data-handling notice linked from mail |
| `PRIVACY_CONTACT` | `SMTP_FROM` | address for data-handling requests, distinct from the no-reply sender |

email refuses to start without a signable unsubscribe link
([bootstrap](bootstrap.md#2-credentials) explains the rotation cost).

### settings page and review bots

| var | default | what it does |
| --- | --- | --- |
| `BOARD_OAUTH_CLIENT_ID`, `BOARD_OAUTH_CLIENT_SECRET` | unset | github oauth app for `/settings` and `/bots` |
| `SESSION_SECRET` | unset | signs board session cookies and unsubscribe tokens. required for both the settings page and email |
| `BOARD_ADMINS` | empty | comma-separated github logins allowed to manage review bots at `/bots` and cut [checkpoints](spec-checkpoints.md) at `/checkpoints` |
| `REVIEW_IDLE_MINUTES` | `10` | quiet time since the note's last edit before a bot writes into it. the editor holds open notes in memory and its periodic save would clobber a concurrent write |

a bot itself lives in the database, one row per bot managed from `/bots`:
name, openai-compatible endpoint, model, optional api key, prompt, and the
namespaces it reviews. it reviews each namespace once per prose version, and
its findings land as `{>>@<name>: ...<<}` threads that block approval until
resolved. troubleshooting is in [operations](operations.md#review-bot-failing).

## editor

the editor is a hedgedoc 1.x derivative and takes
[upstream's `CMD_*` configuration](https://docs.hedgedoc.org/configuration/)
unchanged. what a deployment has to set:

| var | what it does |
| --- | --- |
| `CMD_DB_URL` | the shared database. the editor creates the schema the board reads, so start it first |
| `CMD_DOMAIN`, `CMD_PROTOCOL_USESSL` | public hostname, used to build note URLs |
| `CMD_SESSION_SECRET` | session cookies |
| `CMD_GITHUB_CLIENTID`, `CMD_GITHUB_CLIENTSECRET` | github login. the fork asks for no repo scope: the editor only needs identity |
| `CMD_IMAGE_UPLOAD_TYPE=filesystem` | uploads land on the RWO volume |

two settings exist only in this fork:

| var | what it does |
| --- | --- |
| `CMD_SPEC_BOARD_URL` | the board's public origin. allows it in the editor's CSP `connect-src`, so the approval widget can read namespace roles, and returns it as the CORS origin on `/me`. without it approvals never resolve |
| `CMD_SPEC_DEFAULT_NAMESPACE` | namespace prefilled into the `/new/spec` template. must match the board's `DEFAULT_NAMESPACE` |

[compose.yaml](https://github.com/pfeifferj/specdoc/blob/master/compose.yaml)
is a complete working set of both.
