# checkpoints

specs accumulate. spec 12 says one thing, spec 31 later says something that
partly replaces it, and both sit approved in the same repo. a reader pointed at
`specs/` on the default branch gets a corpus that contradicts itself.

a checkpoint is a git tag on the namespace repo, `specs/v1`, `specs/v2` and
so on, marking a tree whose specs are consistent with each other. pin a reader
to a checkpoint instead of the moving default branch:

```sh
git checkout specs/v3
cat specs/README.md     # the map, frozen at that cut
git show specs/v3       # the manifest: every spec in it, by number
```

the tag prefix keeps these clear of the repo's own release tags, and of
[releases and rebases](release.md), which covers the specdoc images, not spec
content.

a checkpoint does not mean the work is finished. a spec still in review, or a
note edited ahead of what its pull request published, does not block a cut: the
tag describes the tree, so only the tree has to be sound. those land in the next
checkpoint.

## what blocks a cut

`/checkpoints` on the board lists every namespace and what it still owes; each
name links to the page you cut from. overlap between specs is declared by
authors, with `supersedes` and `depends-on`; the gate keeps those declarations
honest.

| blocker | what it means | how to clear it |
|---|---|---|
| `unresolved-ref` | a spec's `supersedes` or `depends-on` names a number no spec has | fix the reference in the note and publish the revision |
| `stale-dep` | a spec depends on one that has since been superseded | re-point the dependency at the replacement, or drop it |
| `unstamped-supersede` | a retired spec's file carries no "superseded by" banner | add it, or replace the spec in the same repo so the next publish stamps it |
| `missing-file` | a published spec's file is not in the tree | restore it, or retire the spec with a replacement |
| `orphan-file` | an `NNN-slug.md` no spec note claims | take it through the board, or delete it |
| `stale-map` | the committed `README.md` no longer matches the graph | open the map refresh pr from the same page and merge it |

`stale-dep` is the check nothing else in the board performs: B was replaced by
C, and A still assumes B.

a namespace publishing at the repo apex (`specs-dir: .`) has no generated
`README.md` and no numbering convention to enforce, so `stale-map` and
`orphan-file` do not apply there. if any published spec has no recorded file
path, the orphan check is skipped instead of guessing, and the page says so.

## overlap findings

where a [review bot](configuration.md#settings-page-and-review-bots) covers the
namespace, opening that namespace's checkpoint page also sends it every approved
spec at once and asks which pairs overlap: two specs describing the same
mechanism, or stating requirements that cannot both hold. pairs already related
by `supersedes` or `depends-on` are dropped, since that is what those fields
are for.

the index does not run the pass, since that is one model call per namespace. a
namespace with fewer than two approved specs, or none the bot covers, says so.

findings are advisory. a model is wrong often enough that letting it veto a tag
would make the gate useless, so the cut only asks you to confirm you read them.
the count and one line per pair go into the tag message, and `git show specs/v3`
is where that record lives.

the whole corpus goes in one request, bounded by `OVERLAP_MAX_BYTES`. specs
that do not fit are named on the page; a first spec over budget goes in
truncated, so the pass has something to read.

findings are held against the repo head, so the cut records what the page
showed instead of re-asking and disagreeing with the count you ticked. editing
a bot drops them; revising a spec on the board does not, so stale findings
stand until the next spec merges.

## cutting one

a login in `BOARD_ADMINS` cuts a checkpoint from `/checkpoints?ns=owner/repo`,
once nothing is left to reconcile. the board creates an annotated tag on the
default branch head; tags are not branch-protected, so this needs no pull
request. the message is the manifest.

there is nothing to roll back: a checkpoint is a tag on a commit that was
already there. delete the tag if one was cut in error, and the next cut reuses
the number only if the deleted one was the highest.
