# bootstrap

standing the stack up from nothing. [onboarding](onboarding.md) is the other
thing called onboarding: adding a repo to a board that already runs.

[architecture](architecture.md#what-a-deployment-has-to-provide) lists what a
deployment has to provide. this page is the order to set it up in.

## 1. github registrations

all three are optional in [local development](local-dev.md) and required in
production.

| what | kind | callback | gives |
| --- | --- | --- | --- |
| editor login | oauth app | `https://<editor-host>/auth/github/callback` | `CMD_GITHUB_CLIENTID`, `CMD_GITHUB_CLIENTSECRET` |
| board login | oauth app | `https://<board-host>/auth/github/callback` | `BOARD_OAUTH_CLIENT_ID`, `BOARD_OAUTH_CLIENT_SECRET` |
| writing to target repos | github app, or a PAT | installed per project repo | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, or `GITHUB_TOKEN` |

the app is preferred: its tokens are scoped to the repos it is installed on and
refresh themselves. a PAT with contents and pull-request write on every
project repo works, and doubles as the fallback when a project has no
installation.

## 2. credentials

each process connects as its own database role, so none carries another's
database credentials; the editor and board share only the signing secret.

| key | service | required |
| --- | --- | --- |
| editor role password, in `CMD_DB_URL` | editor | yes |
| migration role password, as `PGPASSWORD` | board migration job | yes |
| runtime role password, as `PGPASSWORD` | board | yes |
| `EDITOR_SECRET`, equal to the editor's `CMD_SPEC_BOARD_SECRET` | editor and board: signed mutations and approvals | for approvals, locks and bot writes |
| `CMD_SESSION_SECRET` | editor sessions | yes |
| `CMD_GITHUB_CLIENTSECRET` | editor login | yes |
| `GITHUB_TOKEN` | board: roles, scans, PR fallback | one of these two |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | board: per-project tokens | one of these two |
| `SESSION_SECRET` | board sessions, and signing unsubscribe links | for the settings page and for email |
| `BOARD_OAUTH_CLIENT_SECRET` | board `/settings` and `/bots` | for the settings page |
| `SPECDOC_SECRET_KEY` | board: bot API key encryption | for bots with an API key |
| `MONITORING_TOKEN` | board: detailed `/statusz` | optional |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | board email digests | optional |
| `WEBHOOK_URL` | board notifications | optional |

email stays off unless `SMTP_HOST`, `SPEC_BOARD_BASE_URL` and `SESSION_SECRET`
are all set: without them the board cannot sign a compliant unsubscribe link,
and it declines to send rather than ship one that is not. those links carry a
two-year TTL, so rotating `SESSION_SECRET` logs everyone out and dead-links
every unsubscribe URL already sent.

every knob both services read, secrets included, is in
[configuration](configuration.md).

## 3. images

```sh
hack/build-editor.sh                          # editor
podman build -t spec-board:local spec-board   # board
```

the editor build takes its inputs from `editor/UPSTREAM` and
`editor/critic.bundle`; see [releases](release.md).

## 4. run them

create the three postgres roles and a board schema owned by the migration
role.
[deploy/postgres/init.sql](https://github.com/pfeifferj/specdoc/blob/master/deploy/postgres/init.sql)
does this, search paths included, for the local stack; its passwords are
fixtures. point both services at the database, give the editor its volume, and
put each behind its hostname. the editor needs `CMD_DB_URL`, `CMD_DOMAIN` and
the oauth pair; the board needs `PG*`, `HEDGEDOC_BASE_URL`,
`SPEC_BOARD_BASE_URL` and `NAMESPACES`.
[compose.yaml](https://github.com/pfeifferj/specdoc/blob/master/compose.yaml) is
the smallest complete example. start them in this order:

1. the editor, which creates the schema the board reads.
2. the board's migration job, `node server.js --migrate`, as the migration
   role with `BOARD_DB_RUNTIME_ROLE` and `EDITOR_DB_ROLE` set. it creates the
   board's tables and grants the runtime and editor roles their access. run it
   again before each new board version starts.
3. the board, as the runtime role and without the migration credentials. it
   exits at startup if the job has not run or if its role holds more
   privileges than it needs.

kubernetes deployments, ingresses and volumes for a worked example are in
[specdoc-infra](https://github.com/pfeifferj/specdoc-infra). they carry that
cluster's hostnames, storage class and openshift-specific pieces, so treat them
as a template rather than something to apply as-is.

## 5. check it

- open the editor host, sign in with github, create a note
- `curl https://<board-host>/statusz` answers 200 while the poller is healthy;
  a `MONITORING_TOKEN` bearer adds the detail
- `curl https://<board-host>/api/namespaces`: `repo`, `push` and `roles` should
  read `pass` for every configured repo
- then [onboard](onboarding.md) the first repo
