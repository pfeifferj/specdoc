# contributing

the repo is [pfeifferj/specdoc](https://github.com/pfeifferj/specdoc), AGPL-3.0,
default branch `master`. start with [local development](local-dev.md): the whole
stack runs on one machine.

## where things live

| what | where |
| --- | --- |
| editor build inputs | `editor/UPSTREAM`, `editor/critic.bundle` |
| editor rebrand overlay | `editor/overlay.sh`, `editor/branding/` |
| editor source | the `critic` branch inside the bundle, not this tree |
| spec board | `spec-board/server.js`, tests in `spec-board/test.js` |
| docs (this site) | `docs/`, `mkdocs.yml` |
| local deployment | `compose.yaml`, `deploy/` |

## what CI checks on a pull request

- `npm audit --omit=dev --audit-level=high` for the board, CLI and MCP server
- board: an image build, `node spec-board/test.js` and the other unit suites,
  and the postgres-backed suites, on node 24.22.1
- CLI: `npm test` and `npm run test:package` on node 22 and 24
- MCP server: `npm test` on node 24.22.1
- the editor build inputs agree: the fork tree is reconstructed from
  `editor/critic.bundle` and the base commit is checked against the tag in
  `editor/UPSTREAM`
- the board's copied critic parser matches the exported editor source
- `hack/check-editor-audit.cjs` audits the whole installed editor tree and
  fails on any high or critical advisory outside three reviewed build
  exceptions ([dependency advisories](dependency-security.md))
- editor critic regression tests, lint, the full mocha suite and webpack build
  on node 24.22.1 with an immutable yarn install, the postgres receipt and
  device-token race tests, and the CLI/editor integration test
- `editor/overlay.sh` still finds every string it rewrites, run against a real
  checkout of the fork. upstream moving a template is a build failure here
  rather than a silently unbranded image later
- shellcheck on the shell scripts, and `hack/test-build-editor-cache.sh`
- `mkdocs build --strict` when docs change

## conventions

- conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`), subject in the imperative, body explaining why
- lowercase headings and prose in these docs
- comments explain why, never what
- changing anything that stores, sends or publishes user data means updating
  the board's `/privacy` page in the same commit
