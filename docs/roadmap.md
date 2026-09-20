# planning and implementation assignments

the board's **Planning** link organizes implementation work into milestones.
each milestone belongs to one namespace and has a title, description, optional
due date, and open or closed state. a feature spec can belong to one milestone
and have several implementation assignees. both are optional: assign someone
to a spec before deciding which milestone it belongs in.

## planning work

sign in to the board as a namespace approver or board admin. select a namespace
on the planning page and expand **Create a milestone**. a spec's **Assign
implementation** link on the board opens its planning panel, where you choose a
milestone or search for an implementer by username or display name. to fill a
milestone in one go, open it on the planning page and expand **Edit
milestone**: the form lists its specs and the namespace's unassigned ones,
tick or untick and save. implementers need an existing editor account.

implementation assignment is separate from the spec's author and reviewers.
it grants no permissions and does not change approval or implementation status.
moving a spec between milestones keeps its implementers. removing an implementer
does not remove the milestone. changes are saved in the board database; they do
not edit the live note or create a spec revision.

filter the board by milestone or implementer. **Assigned to me** uses your
board sign-in; **No implementer** finds work nobody has taken yet. the existing
board person filter still covers authors and reviewers. the planning page
itself filters by namespace and milestone state.

a milestone's **Edit milestone** form changes its dates, description and state.
closing is manual and can leave unfinished work; reopen it before adding more
specs. due dates are calendar dates, and overdue is evaluated against today's
utc date. concurrent edits return a conflict rather than overwrite someone
else's assignment; reload before applying your change again.

## dependencies

a spec's planning panel lists the `depends-on` frontmatter
described in the [spec lifecycle](spec-lifecycle.md#the-map), with each
prerequisite's state and whether it sits outside the milestone. use note ids
when a spec has no published number yet.

**Ready to implement** means every prerequisite is implemented and the spec
itself is approved; the approval gate checks quorum, unresolved comments,
pending suggestions and role availability. cycles, unresolved references and
superseded prerequisites are reported as blockers on the spec; fix their
`depends-on` references in the notes. top-level specs are inherited design
constraints; they cannot be milestone members or prerequisites.

the computed order (`wave`, blockers, readiness) is served by
[`/api/roadmap`](api.md) for tools that want to plan from it.

## progress and checkpoints

progress uses the board's detected implementation state, from merged commits
with `implements` references. assigning someone or closing a milestone never
marks a spec implemented. superseded specs remain visible in milestone history
and do not count as completed; remove them if they no longer belong in the
milestone. an empty milestone has no progress bar.

only publicly readable specs appear. if an assigned note disappears, becomes
private, changes namespace, or becomes a top-level spec, the milestone shows
an incomplete-progress warning without exposing that note's identity or count.
namespace approvers and board admins can remove assignments for confirmed
deleted notes from the **Deleted specs** panel. planning history is retained;
private or temporarily unavailable notes cannot be removed through this action.

optionally link an existing `specs/vN` [checkpoint](spec-checkpoints.md) in the
milestone edit form. the board validates the tag in the same namespace and
records the resolved commit. the link stays on that commit when the tag moves
or the milestone is edited. to replace the association, clear the checkpoint
and save before linking it again. a checkpoint covers the namespace's specification tree; it does
not certify that the milestone is implemented. linking does not cut a tag, and
cutting a checkpoint does not close a milestone.
