# roadmap and implementation assignments

the board's **Roadmap** link organizes implementation work into milestones.
each milestone belongs to one namespace and has a title, description, optional
due date, and open or closed state. a feature spec can belong to one milestone
and have several implementation assignees. both are optional: assign someone
to a spec before deciding which milestone it belongs in.

## planning work

sign in to the board as a namespace approver or board admin. select a namespace
on the roadmap and expand **Create a milestone**. under a spec's **Assignments
and details**, choose a milestone or search for an implementer by username or
display name. the board's **Assign implementation** link opens the same controls.
implementers need an existing editor account.

implementation assignment is separate from the spec's author and reviewers.
it grants no permissions and does not change approval or implementation status.
moving a spec between milestones keeps its implementers. removing an implementer
does not remove the milestone. changes are saved in the board database; they do
not edit the live note or create a spec revision.

filter the board or roadmap by milestone or implementer. **Assigned to me**
uses your board sign-in; **No implementer** finds work nobody has taken yet.
the existing board person filter still covers authors and reviewers.

a milestone's **Edit milestone** form changes its dates, description and state.
closing is manual and can leave unfinished work; reopen it before adding more
specs. due dates are calendar dates, and overdue is evaluated against today's
utc date. concurrent edits return a conflict rather than overwrite someone
else's assignment; reload before applying your change again.

## dependency order

the roadmap reads the existing `depends-on` frontmatter described in the
[spec lifecycle](spec-lifecycle.md#the-map). it includes drafts and specs under
review, as well as approved and implemented work. use note ids when a spec has
no published number yet.

read dependency steps from left to right. specs in a step may be implemented in
parallel once their prerequisites are implemented and they are approved.
**Ready to implement** means both conditions hold. a draft without dependencies
still needs review. the existing approval gate checks quorum, unresolved
comments, pending suggestions and role availability. these steps express ordering, not estimated dates or effort.
dependencies outside the selected milestone remain linked on each spec.

cycles, unresolved references, superseded prerequisites, and work downstream
of those problems appear under **Needs attention**. fix their `depends-on`
references in the notes. top-level specs are inherited design constraints;
they cannot be milestone members or implementation prerequisites.

## progress and checkpoints

progress uses the board's detected implementation state, from merged commits
with `implements` references. assigning someone or closing a milestone never
marks a spec implemented. superseded specs remain visible in milestone history
and do not count as completed; remove them if they no longer belong in the
milestone. an empty milestone has no percentage.

only publicly readable specs appear. if an assigned note disappears, becomes
private, changes namespace, or becomes a top-level spec, the milestone shows
an incomplete-progress warning without exposing that note's identity or count.

optionally link an existing `specs/vN` [checkpoint](spec-checkpoints.md) in the
milestone edit form. the board validates the tag in the same namespace and
records the resolved commit. the link stays on that commit when the tag moves
or the milestone is edited. to replace the association, clear the checkpoint
and save before linking it again. a checkpoint covers the namespace's specification tree; it does
not certify that the milestone is implemented. linking does not cut a tag, and
cutting a checkpoint does not close a milestone.
