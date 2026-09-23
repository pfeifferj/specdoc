# planning and implementation assignments

the board's **Planning** link organizes implementation work into milestones.
each milestone belongs to one project and has a title, description, optional
due date, and open or closed state. a feature spec can belong to one milestone
and have several implementation assignees. both are optional: assign someone
to a spec before deciding which milestone it belongs in.

## planning work

sign in to the board as a project approver or board admin. select a project
on the planning page and expand **Create a milestone**. a spec's card menu on
the board holds a **Milestone** select and **Set milestone**, so the milestone
is set without leaving the board: the save returns to the board you were
looking at, with its search and filters intact, and says which milestone the
spec is now in. the card's **Implementation plan** link opens the spec's
panel, headed the same, where you search for an implementer by username or
display name. type at least two characters, choose a match from the dropdown,
then press **Add implementer**. the arrow keys move through matches, enter
selects one, and escape closes the dropdown. a viewer who cannot assign
reaches the same panel, and it says who may change it.

to fill a milestone in one go, open it on the planning page and expand **Edit
milestone**: the checklist covers the project's specs apart from superseded
and top-level ones. its members and the specs no milestone holds are rows in
the list; a spec another milestone holds sits behind **Held by other
milestones**, labelled `(in <milestone>)`, and ticking it moves it here on the
same save. unticking a member leaves the spec with no milestone. every member
is listed; unassigned specs fill the list up to one hundred rows and the
disclosure holds one hundred, and a form that had to cut either reads
`Showing N of M specs.` with a link to the board, where the spec's card menu
reaches what the form does not list. on a page listing more than twenty
milestones each form lists only its own members and links to the milestone's
page, where the full list is offered. implementers need an existing editor
account.

every milestone card lists its specs to any visitor, signed in or not: title,
status, readiness, implementers and blockers, each with a **Details** link to
the spec's planning panel. **See these on the board** under the list opens the
board filtered to that milestone.

implementation assignment is separate from the spec's author and reviewers.
it grants no permissions and does not change approval or implementation status.
moving a spec between milestones keeps its implementers. removing an implementer
does not remove the milestone. changes are saved in the board database; they do
not edit the live note or create a spec revision.

filter the board by milestone or implementer, then press **Show these specs**.
**Assigned to me** uses your board sign-in; **No implementer** finds work
nobody has taken yet. the existing board person filter still covers authors and
reviewers. the planning page itself filters by project and milestone state.

a milestone's **Edit milestone** form changes its dates, description and
state. **Delete this milestone** opens the delete step, and **Delete
permanently** inside it removes the milestone: its specs are unassigned and
keep their implementers. closing is manual and can leave unfinished work;
reopen it before adding more specs. due dates are calendar dates, and overdue
is evaluated against today's utc date. concurrent edits return a conflict
rather than overwrite someone else's assignment. the conflict page offers
**Apply my changes on top**, which re-posts what you typed on the stored
version; a milestone save also lists the fields the other save changed as
`theirs, yours` and what your own save will apply. a save that stored the
milestone fields and then hit a conflict on a spec is headed `Saved the
milestone, but not every spec`, and the same button applies the rest. any
other refusal gives the form back with what you typed, and a sign-in that has
expired prints it instead so it survives signing in again.

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
private, changes project, or becomes a top-level spec, the milestone shows
an incomplete-progress warning without exposing that note's identity or count.
project approvers and board admins can remove assignments for confirmed
deleted notes from the **Deleted specs** panel. planning history is retained;
private or temporarily unavailable notes cannot be removed through this action.

optionally link an existing `specs/vN` [checkpoint](spec-checkpoints.md) in
the milestone edit form. the board validates the tag in the same project and
records the resolved commit. the link stays on that commit when the tag moves
or the milestone is edited. to replace the association, clear the checkpoint
and save before linking it again. a checkpoint covers the project's
specification tree; it does not certify that the milestone is implemented.
linking does not cut a tag, and cutting a checkpoint does not close a
milestone.
