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
| writing to target repos | github app, or a PAT | installed per namespace repo | `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, or `GITHUB_TOKEN` |

the app is preferred: its tokens are scoped to the repos it is installed on and
refresh themselves. a PAT with contents and pull-request write on every
namespace works, and doubles as the fallback when a namespace has no
installation.

## 2. credentials

one secret per service, so no process carries another's.

| key | service | required |
| --- | --- | --- |
| `CMD_DB_PASSWORD` | editor, board, postgres | yes |
| `CMD_SESSION_SECRET` | editor sessions | yes |
| `CMD_GITHUB_CLIENTSECRET` | editor login | yes |
| `GITHUB_TOKEN` | board: roles, scans, PR fallback | one of these two |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | board: per-namespace tokens | one of these two |
| `SESSION_SECRET` | board sessions, and signing unsubscribe links | for the settings page and for email |
| `BOARD_OAUTH_CLIENT_SECRET` | board `/settings` and `/bots` | for the settings page |
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

point both at the database, give the editor its volume, and put each behind its
hostname. the editor needs `CMD_DB_URL`, `CMD_DOMAIN` and the oauth pair; the
board needs `PG*`, `HEDGEDOC_BASE_URL`, `SPEC_BOARD_BASE_URL` and `NAMESPACES`.
[compose.yaml](https://github.com/pfeifferj/specdoc/blob/master/compose.yaml) is
the smallest complete example.

the editor creates the schema the board reads, so start it first, or let the
board crash-loop until the tables exist.

kubernetes deployments, ingresses and volumes for a worked example are in
[specdoc-infra](https://github.com/pfeifferj/specdoc-infra). they carry that
cluster's hostnames, storage class and openshift-specific pieces, so treat them
as a template rather than something to apply as-is.

## 5. check it

- open the editor host, sign in with github, create a note
- `curl https://<board-host>/statusz` for poller state
- `curl https://<board-host>/api/namespaces`: `repo`, `push` and `roles` should
  read `pass` for every configured repo
- then [onboard](onboarding.md) the first repo
