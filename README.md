# specdoc

<img src="docs/mascot.png" alt="specdoc mascot" width="140" align="right">

spec collaboration and lifecycling that isn't terrible.

specs usually rot in a docs platform nobody reviews or a PR nobody can edit
together. specdoc uses [hedgedoc](https://hedgedoc.org) under the hood. specs
are collaborative markdown notes with inline criticmarkup comments, reviewed
on a kanban board, and finally created as PRs in their target repo once approved.

![spec board with draft, review, and approved lanes](docs/board.png)

![editor with criticmarkup suggestions and margin comments](docs/editor.png)

## workflow

a note becomes a spec via frontmatter `tags: [spec, <status>]` with statuses
`draft`, `ready-for-review`, `in-review`, `approved`, `implemented`.
reviewers and quorum come from `.specs/roles.yml` in the branch-protected
target repo. a comment thread starts the review; approval needs quorum plus
every thread resolved, then the board locks the note and opens
`specs/NNN-slug/spec.md` as a PR under the author's own github identity. a
commit containing `implements #N` closes the loop.

full walkthrough: [spec lifecycle](docs/spec-lifecycle.md). adding a repo:
[onboarding a project](docs/onboarding.md).

## license

AGPL-3.0 (see [LICENSE](LICENSE)); the editor is a hedgedoc derivative and
keeps its license. `editor/critic.bundle` holds the fork's commits over the
upstream base tag. bundled source sans pro fonts are SIL OFL 1.1
([spec-board/fonts/LICENSE](spec-board/fonts/LICENSE)).
