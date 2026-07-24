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
| manifests for the reference deployment | [specdoc-infra](https://github.com/pfeifferj/specdoc-infra) |

## what CI checks on a pull request

- `node spec-board/test.js`
- the editor build inputs agree: the fork tree is reconstructed from
  `editor/critic.bundle` and the base commit is checked against the tag in
  `editor/UPSTREAM`
- `editor/overlay.sh` still finds every string it rewrites, run against a real
  checkout of the fork. upstream moving a template is a build failure here
  rather than a silently unbranded image later
- shellcheck on the shell scripts
- `mkdocs build --strict` when docs change

## conventions

- conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`), subject in the imperative, body explaining why
- lowercase headings and prose in these docs
- comments explain why, never what
- changing anything that stores, sends or publishes user data means updating
  the board's `/privacy` page in the same commit

