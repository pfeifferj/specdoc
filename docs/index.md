# specdoc

spec collaboration and lifecycling that isn't terrible.

specs usually rot in a docs platform nobody reviews or a PR nobody can edit
together. specdoc uses [hedgedoc](https://hedgedoc.org) under the hood. specs
are collaborative markdown notes with inline criticmarkup comments, reviewed on
a kanban board, and finally opened as PRs in their target repo once approved.

![spec board with draft, review, and approved lanes](board.png)

![editor with criticmarkup suggestions and margin comments](editor.png)

## the short version

a note becomes a spec via frontmatter `tags: [spec, <status>]` with statuses
`draft`, `ready-for-review`, `in-review`, `approved`, `implemented`. reviewers
and quorum come from `.specs/roles.yml` in the branch-protected target repo. a
comment thread starts the review; approval needs quorum plus every thread
resolved, then the board locks the note and opens `<specs-dir>/NNN-slug.md` as
a PR. a commit containing `implements #N` closes the loop.

## where to go next

- reviewing or writing a spec: [spec lifecycle](spec-lifecycle.md)
- putting your repo on the board: [onboarding a repo](onboarding.md)
- running the thing: [architecture](architecture.md),
  [bootstrap](bootstrap.md), [configuration](configuration.md),
  [operations](operations.md)
- changing it: [contributing](contributing.md),
  [local development](local-dev.md), [releases](release.md)

## license

AGPL-3.0 (see [LICENSE](https://github.com/pfeifferj/specdoc/blob/master/LICENSE)).
the editor is a hedgedoc derivative and keeps its license;
`editor/critic.bundle` holds the fork's commits over the upstream base tag
recorded in `editor/UPSTREAM`, which together are its corresponding source.
