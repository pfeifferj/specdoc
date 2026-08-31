# spec lifecycle

a note is a spec when its frontmatter tags include `spec` plus a status tag.
the most advanced status tag wins; no status tag means draft.

```yaml
---
title: Realtime presence cursors
tags: [spec, draft]
owner: octocat
namespace: owner/repo
---
```

## creating a spec

the board's "new spec" button (with a namespace picker when more than one
repo is onboarded) opens the editor with the template: `spec` and `draft`
tags set, `owner` prefilled with your github login, `namespace` from the
picker or the default.

## statuses

| status | meaning | how it's reached |
|---|---|---|
| `draft` | being written | default for any spec note |
| `ready-for-review` | author considers it reviewable | "mark ready for review" in the editor navbar, or edit the tag |
| `in-review` | review underway | automatic once the first comment thread appears (computed by the board; resolving every thread reverts it), or "start review" |
| `approved` | quorum met, threads resolved | the approval that meets quorum flips the tag |
| `implemented` | implementing commit merged | an `implements` commit is detected; the card leaves the board |

cards in the review columns get a stale marker after `STALE_DAYS` (default
14) without changes.

![board lanes with namespace chips, approval counts, PR links, and a stale marker](board.png)

## review

reviewers work inside the note with criticmarkup; the toolbar covers all of
it, nobody needs to learn the syntax:

![editor with suggestion markup in the pane and margin comment bubbles in the preview](editor.png)

- comments: `{>>@name: text<<}`, shown as margin bubbles and inline pills.
  adjacent comments form a thread; the reply box appends to it.
- suggestions: insert, delete, and replace spans with accept/reject buttons.
  a pending one blocks approval like an open thread does, because the PR is
  written with every suggestion in its accepted form: approving around one
  would publish an edit no approver agreed to. accept or reject it and the
  markup is gone, which clears the gate. highlights are not edits and never
  block.
- resolving a thread means accepting or deleting its markup, or the bubble's
  resolve button. unresolved threads show on the card and block approval.
  resolved ones stay in the note and read back through "show resolved" in the
  toc menu; reopening one means deleting its `{>>%%resolved%%<<}` marker in
  the editor pane.
- each thread has a deep link: the bubble's copy-link button yields
  `<note-url>#comment-<hash>`, which on load scrolls to and highlights that
  thread. the hash is derived from the first message's author and text, so a
  link survives edits elsewhere in the note but breaks if that message's text
  changes. bot review notifications link straight to the thread the bot added.

approvers from the namespace's `.specs/roles.yml` get an approvals dropdown
in the navbar: the full roster with each approver's state. approve shows
while the spec is `ready-for-review` or `in-review`; approvals land in the
note's `approved-by` list and can be retracted.

## what approval triggers

once the `approved` tag is set, quorum is met, and no thread remains open,
the board (within one poll interval):

- locks the note via hedgedoc's `locked` permission: everyone reads, only
  the owner edits. one-shot; an owner who deliberately unlocks later isn't
  re-locked.
- opens the spec PR: `<specs-dir>/NNN-slug.md` (or
  `<specs-dir>/<area>/NNN-slug.md` when the note declares an area),
  criticmarkup resolved to its accepted form, frontmatter stripped, first
  paragraph as the PR abstract. the board tries the spec owner's github token
  first and falls back to its own; the fallback is logged, not shown in the PR.
- the PR number becomes the spec's reference number.

the spec commit carries gerrit-style trailers, so `git log` records the
review in the target repo:

```
spec: add 013 New approach

Spec-Id: rBk2DfsJR52onFFi8X5u-A
Reviewed-on: https://<editor-host>/rBk2DfsJR52onFFi8X5u-A
Reviewed-by: @alice
Reviewed-by: @bob
```

`Spec-Id` is the note's stable id, `Reviewed-on` links back to the note, and
`Reviewed-by` is emitted per approver who signed off. a `Supersedes:` trailer
is added when the spec replaces another.

a trailer is permanent public attestation, so the bar for one is higher than
for quorum: the approver must be in `roles.yml`, be listed in `approved-by`,
and be someone hedgedoc recorded as having written to the note. approving from
the navbar satisfies all three. an approver with no hedgedoc account, or a name
someone else typed into `approved-by`, still counts toward quorum but gets no
trailer, and the poller logs it as an unattested approval.

an `approved` tag without quorum, with open threads, or with pending
suggestions gets the PR withheld (logged by the poller, and the card says
which); the tag alone is never enough on a governed repo.

## implemented

the spec completes when a commit referencing it merges to the default branch
of one of the namespace's implementation repos:

```
feat: presence cursors

implements #12
```

a bare `#12` resolves against the repo being scanned, so it only works for code
living in the spec repo itself. from anywhere else write
`implements owner/spec-repo#12`. the board marks
the spec implemented, sends a notification, and drops the card while keeping
its state.

## revising a merged spec

a change that keeps the spec's identity, like a correction the implementation
forced, is edited in place rather than replaced. approval locks the note, so
the owner unlocks it or makes the edit themselves:

1. drop the `approved` tag back to `in-review` (the automatic bump only fires
   from `ready-for-review`, so an approved note stays put until the tag moves).
2. review and adapt as usual; the `approved-by` list and the threads work the
   same way.
3. approve again. quorum and open threads are re-checked from scratch.

the board then opens a revision PR against the same spec file, on the spec's
own branch name plus `-r1` (`-r2` for the next revision, and so on), with the
commit `<prefix>update NNN Title` and fresh `Reviewed-by` trailers. the card
links it as `rev #<pr>` next to the original.

the tag round trip is the convention, not the gate: any edit to a merged spec
that still meets quorum with no open threads publishes a revision. as with the
first PR, landing it is a human merge in the target repo.

the original PR number stays the spec's number: `implements` and `supersedes`
refs keep pointing at it, and a title edit never re-paths the file. further
edits while the revision PR is open land on the same branch; the next edit
after it merges or closes starts the next revision. re-approving without
touching the content publishes nothing, and neither does editing the
`namespace` frontmatter, which stays pinned to the repo the spec published to.

a spec that merged before the board tracked revisions has no record of what it
published, so the first poll that sees it approved treats the note as it stands
as the published text. only edits after that count as a revision.

## superseding a spec

when a spec needs replacing rather than editing, start a replacement: any
card with a PR carries a `replace` link (`show implemented` reveals shipped
specs so those are replaceable too). it opens a new spec in the same
namespace with `supersedes` prefilled:

```yaml
supersedes: 12          # a spec number in this namespace
# supersedes: owner/repo#12   # or one in another namespace
```

the replacement is an ordinary spec and goes through its own review. nothing
happens to the old spec until the replacement's PR opens, so an abandoned
replacement never retires a live spec. once approved:

- the old spec drops off the board (state kept, like an implemented spec).
- the old spec file gets a "superseded by #M" banner, committed on the
  replacement's branch so it rides in the same PR (same-repo, once the old
  spec has merged; cross-repo or not-yet-merged targets are left to the
  webhook).
- the replacement commit records a `Supersedes: owner/repo#N` trailer, and
  the board posts the supersede on the webhook.

use a bare number for a same-namespace target: yaml reads an unquoted
leading `#` as a comment, so `supersedes: #12` silently drops the value.

## the map

`depends-on` records what a spec builds on. it takes the same reference forms
as `supersedes`, but a list of them:

```yaml
depends-on: [12, 7]           # spec numbers in this namespace
# depends-on: [owner/repo#12] # or in another namespace
```

the same yaml gotcha applies, so prefer bare numbers. a reference that matches
no tracked spec is drawn anyway, marked unknown, rather than dropped quietly.

from `depends-on`, `supersedes` and the area each spec declares, the board
derives a map of the approved and implemented specs: what the system is, as
opposed to what is in flight, which is what the board itself shows. nothing
about it is hand-maintained, and it appears in two places.

- the board's `map` link, grouped by namespace and area, with each spec's first
  paragraph, what it depends on, and what depends on it.
- `README.md` in the namespace's specs dir, as a mermaid diagram plus a table.
  github renders it when anyone browses the directory. it is written on the
  spec pr's own branch, alongside the spec file, so it lands when that pr
  merges and never has to push to a protected default branch. it lists only
  specs that have a number, since those are the ones with a file in the repo. a
  namespace that publishes at the repo apex gets no `README.md`: that file is
  the project's own, so set `specs-dir: .` in `roles.yml` to opt out.

because it rides in the spec pr, the repo copy refreshes when a spec is
published, not when one is implemented. a spec that shipped since the last
publish still reads `approved` there until the next spec lands; the board's
`map` is always current.

## the rendered view

hedgedoc hides frontmatter from the rendered half, so a spec's identity used to
be readable only in the source pane. the editor now renders it as a header above
the document: title, phase, owner, namespace, area, and the `supersedes` /
`depends-on` targets as links. it is built from the frontmatter alone, so it
costs no request and works on a spec that has never been published.

references to other specs in the prose are linked too, in the two spellings the
board already parses:

```
see #12 for the routing model          a spec in this note's namespace
see netfyr/specs#12 for the details    a spec in another one
```

a link goes to `<spec board>/spec/<owner>/<repo>/<n>`, which redirects to the
reviewable note when the board tracks that spec and to its pull request
otherwise, so a reference to an unpublished spec still lands somewhere. this
needs `CMD_SPEC_BOARD_URL` set on the editor; without it references stay plain
text.

what is deliberately not linked: anything in code spans or fenced code, since a
number in a command is not a reference; anything inside a heading, because
heading ids are derived from their rendered html and linking there would move
every anchor; and `#12ab34` or `##12`, which are not references.

the published `/s/` view carries the prose links but no header: the server
strips the frontmatter before that page renders.

## notifications

with a webhook configured, the board posts on: status moves, new comments
during review, approvals, the post-approval lock, PR opened, revision PR
opened, supersede, and implementation.
