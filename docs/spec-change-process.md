# spec change process

Current requirements live in merged Markdown specs. Review a short change
proposal next to the exact spec diff, and archive the proposal after merge.
Publish related specs in one change when publishing them separately would leave
a requirement without an owner.

The board enforces the single-note publication rules on this page. The
multi-document `contract-v1` format and partial replacement are
[proposals](#multi-document-changes-proposed).

## status

| Mechanism | State |
| --- | --- |
| Offline preview of sources, diffs, requirement transfers, capabilities and rules | Implemented: [change preview](change-preview.md) |
| Relation diagnostics and consistency review of related specs | Implemented. An invalid relation, including a cross-project `supersedes`, blocks publication. |
| Numeric GitHub identities and project admission | Implemented |
| Candidate-bound approval and submission receipts, publication metadata, retirement after a verified merge | Implemented for single-note publications |
| Multi-document capability transfers and partial replacement | Proposed |

## project admission

A project publishes only while its `.specs/roles.yml` (or root `roles.yml`) is
present, valid and readable. The file lists approvers and authors by numeric
GitHub account ID ([onboarding](onboarding.md#rolesyml-semantics)). A note
publishes, gets model review or sends notifications only when its owner's
account is in one of those lists. The note's own `owner` and `approved-by`
fields confer nothing.

`approvals-required: 0` removes the approval count but still requires an
admitted owner, a public note, valid relations and no open review markup. The
board never publishes private, protected or limited notes. Board administrators
are the accounts in `BOARD_ADMIN_IDS` that signed in within the last hour.

## candidates and approvals

An approval counts only for the candidate it was given on. A note's candidate
is a SHA-256 over its note ID, project, title, owner account, area, kind,
relations, visibility, body with review markup, and a hash of the project's
`roles.yml`. Status tags and the note's `approved-by` list are not part of it,
so moving from `in-review` to `approved` keeps every approval. Any other change
needs fresh approvals, including a resolved thread, an edit to `depends-on` or
`supersedes` alone, or an edit to `roles.yml`. Earlier approvals stay on record
and count for nothing, as do approvals recorded without a candidate, policy
hash and account ID.

The editor signs the approver's GitHub account ID and the hash of the saved
note. The board records the approval only if the locked note still has that
hash, and binds it to the current candidate.

## submission and merge

Just before publishing, the board locks the note, its publication state and its
approval rows, in that order. It rechecks policy, visibility, moderation,
admission and quorum, then commits an immutable submission holding the exact
document. That commit is the authorization cutoff: an edit or retraction
committed before it stops the submission, and one committed after it cannot
change the submitted bytes and needs a new candidate. The `locked` note
permission set after approval is a collaboration aid, not the authorization
boundary; the owner can still edit a locked note.

Each published file starts with a `<!-- specdoc-publication:... -->` comment
whose base64url JSON holds the submission ID, note ID, project, candidate hash,
body hash and reviewed relations. Snapshot hashes cover the Markdown bytes each
snapshot holds and are separate from candidate hashes. The random submission ID
also appears in the PR branch name and in a marker in the PR description, so a
shared title or a familiar branch name cannot take over another note's
publication.

| Receipt | Records |
| --- | --- |
| Approval: what the approver saw | GitHub account ID and login, candidate hash, policy hash, published-text hash, decision and time |
| Submission: what the board sent | Submission ID, note, project, candidate and policy hashes, credited approvals, exact document and its hash, relations, path, branch, base commit, revision and PR number |
| Merge: what was accepted | Submission ID, candidate hash, PR number, merged commit, and the relations, title, area and kind it published |

The original PR number stays the spec's reference across revisions. Each
revision gets its own submission and merge receipt, so an original merged PR
cannot authorize later edits. The board writes a merge receipt only when the
file at the submitted path, in the recorded repository, base branch and PR,
matches the submitted document hash, metadata and relations. A matching PR
number or title is not enough. Other files in the PR, such as the spec map and
the "Superseded by" banner, are not verified. Squash and rebase merges can
change the commit, but the file bytes and relations must still match. A
submission with an uncertain outcome is recovered through its submission ID
instead of a new PR.

## checkpoints and maps

Checkpoint tags have the same kind of cutoff. Before tagging, the board locks
the source notes, rechecks their content, visibility, admission and moderation,
and commits an audit event with the exact manifest, repository head and
administrator identity; GitHub receives that recorded manifest. Hiding or
changing a source before the commit stops the cut, and later edits go into the
next checkpoint. Overlap findings and changelog summaries are cached against
the repository head and each source's ID, title, owner and candidate.

Spec maps pass the same source checks, include only admitted, public notes, and
keep the exact document and destination in their audit event. A map refresh
uses a new random branch, so it cannot reset an unrelated branch or adopt an
unrelated PR.

## when a replacement takes effect

Only a verified merge receipt retires a spec or, under the
[proposal](#multi-document-changes-proposed), moves a requirement to another
spec. A pending replacement stays visible next to the spec it replaces, and
closing or abandoning it leaves the current requirements in force. Retirement
reads the relations saved in the merge receipt, never the live note: if an
author later edits a merged spec's `supersedes` to name another predecessor,
nothing retires until a revision with that relation merges. Cross-project
retirement is refused, including through note IDs.

A retirement record keeps the replacement's submission ID and merged commit. A
board administrator reverses one with `POST /admin/specs/:noteId/unretire`,
sending the session's CSRF value and a `reason` form field. The reversal is
audited, and that submission never retires the spec again; a later merged
revision of the replacement that still declares `supersedes` is a new
submission and can.

A `superseded_at` value without a verified receipt, written before the board
kept merge receipts, stays in `spec_board_state` but is ignored, so the spec
shows as active and can publish revisions. No board route reinstates it; only a
verified merge of a replacement publication that declares `supersedes` retires
the spec again. List these rows and check each against the target repository's
merged history, not the note's current frontmatter:

```sql
SELECT note_id, superseded_at FROM spec_board_state
WHERE superseded_at IS NOT NULL AND supersession_receipt IS NULL;
```

Deleting a published note keeps its submission, approval and publication
records, including publication identity and approval hashes. Removing sensitive
text from them takes the audited offline redaction command
([security](security.md)).

## multi-document changes (proposed)

Nothing in this section is implemented. The single-note candidate and quorum
rules above apply to it unchanged.

A spec keeps its document identity and published path; a rename or replacement
leaves a historical stub at the old path. Each spec carries one versioned
metadata block, written by the publisher, with its identity, provided and
required capabilities, and typed relations. Editor status, approval lists and
review state stay out of it:

```text
<!-- specdoc-contract-v1
{"id":"document-a","provides":["state.model"],"requires":[],
 "relations":[{"type":"supersedes","target":"document-old",
 "scope":{"kind":"partial","obligations":["document-old:FR-001"]}}],
 "change":"separate-model-and-decoding"}
-->
```

Relation types are those of the [change preview](change-preview.md):
`normative`, `implementation`, `publication` and `supersedes`. References
resolve by document identity, never by filename digits. A `partial` replacement
names each source document and requirement it takes over and leaves the rest
active. A `full` replacement needs review of the old spec's whole inventory,
with a decision for every displaced requirement and consumer. The graph checks
that destinations exist; reviewers decide whether transfers preserve meaning.

A change proposal records its `changeId`, exact base identities, hashes of the
proposed files, decisions for changed requirements, capabilities, relations and
exceptions. It links to unchanged specs instead of copying their prose. After
merge it is archived unchanged, and later edits need a new proposal. Current
requirements and relations come from the merged specs: the publisher generates
metadata from the selected proposal and checks the output bytes, and the graph
comes from that metadata rather than a hand-kept index.

The `changeId` stays fixed across content hashes and PR numbers. A
`candidateId` names one exact version: the SHA-256 of a versioned canonical
encoding of the base identities, proposed file hashes and semantic metadata,
excluding its own digest, receipt data, local checkout paths and display text.

When every affected spec is in one repository, their edits, historical stubs
and metadata publish in one reviewed PR. Changes across repositories need
pinned versions of each participant and a separate protocol for when they take
effect, since Git cannot merge repositories atomically. Accepting part of a
proposal needs a valid smaller change, and opening one participant's PR does
not retire the others.

Migration keeps the current relation checks and reference forms, existing
published bodies and hashes, and every historical export's format and hash.
`publication-format: contract-v1` needs its own structural validator and an
opt-in migration. Adopting it for a spec takes a reviewed change, and old
approval and publication snapshots are never recalculated under the new format.

## acceptance cases

Rows marked proposed depend on the multi-document format.

| Case | Required behavior |
| --- | --- |
| Invalid relation | Show a diagnostic and withhold publication; drafting continues. |
| Unknown identity or empty required selection (proposed) | Same as an invalid relation. |
| Related specs disagree | Keep the pair in consistency review; a dependency does not establish agreement. |
| Text or semantic metadata changes | New candidate; old approvals stay on record without credit. |
| Deliberate reopen from `approved` | End the earlier approval round. |
| Edit or retraction during a publication tick | Reread under the final locks and reject the stale candidate before authorization commits. |
| Edit after authorization commits | Publish only the submitted bytes; the edit needs a new candidate. |
| Replacement open or abandoned | The predecessor stays in force, with no retirement event. |
| Verified or recovered merge | Apply the exact published relations once; reprocessing is idempotent. |
| Live relation changes after the original PR merged | Keep the graph from the relevant merge receipt. |
| Wrong target or mismatched document hash | Fail merge verification and activate nothing. |
| Extra changed spec in the PR (proposed) | Fail verification without partial activation. |
| Format support enabled on an existing project (proposed) | No mass publication, hash rewrites or invented historical reviews. |
| GitHub login renamed or reused | Authority follows the account ID; a new account gets none of the old account's roles. |

Reviewers decide whether the inventory is complete, transfers preserve meaning,
withdrawals are justified and a rule drawn from a top-level spec is worth
enforcing. Project configuration supplies rules, namespaces and branding;
SpecDoc's own defaults stay generic.
