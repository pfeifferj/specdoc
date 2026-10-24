# Specification change process

Updated 24 October 2026. The local changes have not been deployed. The single-note security rules below are implemented; the multi-document `contract-v1` format remains a proposal.

Keep current requirements in merged Markdown specs. Review a short change proposal alongside the exact spec diff, then archive the proposal after merge. Include related documents in the same change when publishing them separately would leave a requirement without an owner.

## Implementation status

| Mechanism | State |
| --- | --- |
| Offline preview of sources, diffs, requirement transfers, capabilities and declared rules | Implemented locally; see [change preview](change-preview.md). |
| Visible malformed relation diagnostics and review of already-related pairs | Implemented locally. Invalid relations block publication. Cross-project supersession is rejected. |
| Published relationship metadata, candidate-bound approval/submission receipts, and retirement after verified merge | Implemented locally for single-note publications. |
| Immutable GitHub identities, explicit project admission and fresh approval quorum | Implemented locally. Legacy login-only policy and unbound approvals cannot authorize publication. |
| Multi-document capability transfers and partial replacement | Proposed below; not implemented. |

## Project admission and authority

Projects must have a valid protected `.specs/roles.yml` or root `roles.yml`. Missing files, invalid policy, and unavailable or stale policy disable publication. `approvers` and `authors` identify immutable GitHub account IDs; an optional login is a display label. A note owner must be in either roster before it can trigger publication, model review or notifications. Note-authored `owner` and `approved-by` fields confer no authority.

```yaml
authors:
  - id: "10001"
    login: contributor
approvers:
  - id: "10002"
    login: reviewer
approvals-required: 1
```

Numeric ID strings such as `approvers: ["10002"]` are also accepted. Zero-approval publication requires an explicit `approvals-required: 0`; it still requires an admitted owner, public editor permissions, valid relations and no unresolved review markup. Private, protected and limited notes are never published by the service. Administrator configuration uses `BOARD_ADMIN_IDS` and recent GitHub authentication.

## Contracts and change bundles

A spec keeps its document identity and published path. A rename or replacement leaves a historical stub at the old path. Each spec contains its requirements and one versioned metadata block written by the publisher. The block records identity, provided and required capabilities, and typed relationships. Editor status, approval lists and temporary review state stay out of it.

Proposed `contract-v1` format:

```text
<!-- specdoc-contract-v1
{"id":"document-a","provides":["state.model"],"requires":[],
 "relations":[{"type":"supersedes","target":"document-old",
 "scope":{"kind":"partial","obligations":["document-old:FR-001"]}}],
 "change":"separate-model-and-decoding"}
-->
```

Relation types are `normative`, `implementation`, `publication` and `supersedes`. Resolve references using the selected document identities, never filename digits. A `partial` replacement identifies each source document and requirement, and leaves the rest active. A `full` replacement requires review of the complete old inventory, with a decision for every displaced requirement and consumer. The graph checks that the destinations exist. Reviewers decide whether the transfers preserve meaning.

A change proposal records its `changeId`, exact base identities, hashes of proposed files, decisions for changed requirements, capabilities, relationships and exceptions. Link to unchanged specs instead of copying their prose. After merge, archive the proposal unchanged and use a new proposal for later edits. Current requirements and relationships come from the merged specs. Generate metadata from the selected proposal and check the output bytes. Generate the graph from that metadata rather than maintaining a separate relationship index by hand.

## Review, submission and merge receipts

A stable `changeId` identifies a proposal separately from its content hash and publication PR number. A `candidateId` identifies one exact version: it is the SHA-256 of a versioned canonical encoding of the selected base identities, proposed file hashes and semantic metadata. That encoding excludes its own digest, receipt data, local checkout paths and display text. The review, publication and merge services save receipts for their existing events. Each receipt retains the publication or revision identity and an idempotent recovery key.

| Receipt | Records |
| --- | --- |
| Review | Actor, eligible role/policy revision, saved source hash, selected candidate ID, decision and timestamp. This identifies what the reviewer saw. |
| Submission | Candidate ID, namespace/repository, exact participating paths and hashes, original document reference, this publication PR/revision and submitted head commit. This identifies what the publisher submitted. |
| Merge | Submission identity, verified merged PR, merge/effective commit, participating blob IDs/hashes and exported relationships. This identifies the accepted files and metadata. |

For a single note, the current candidate includes its title, namespace, owner subject, area/kind, normalized relations, raw review body and governance policy. Workflow status tags and the note-authored approval list are excluded, so changing `in-review` to `approved` does not invalidate an otherwise unchanged review. Text, semantic metadata, review-resolution and policy changes require fresh approvals. Old receipts remain evidence but count for zero. Legacy approval rows without a candidate, policy and immutable subject also count for zero.

The editor signs the saved source hash and immutable GitHub subject. Approval recording locks the persisted note and binds the receipt to the current candidate. Immediately before publication, the board locks the note, publication state and approval rows in that order, checks current policy, visibility, moderation, admission and quorum, and commits an immutable submission containing the exact authorized document. This transaction commit is the authorization cutoff. A retraction or edit committed before it prevents submission. Later edits cannot alter the already authorized bytes and require a separate candidate. Permission locking is a collaboration aid, not the authorization boundary; owners can still edit a locked note.

Published files carry a `specdoc-publication` metadata comment with the submission ID, note identity, candidate digest, body digest and reviewed relations. Snapshot body hashes continue to identify actual Markdown bytes, separately from candidate hashes. Recovery verifies the exact repository, original default branch, PR, path, merged commit, metadata and document digest. A random submission ID also appears in the branch and PR marker. A shared title or familiar branch slug cannot transfer publication identity.

The original publication reference stays stable across revisions. Each revision gets its own submission and merge receipts; an original merged PR cannot authorize later edits. Check the merged tree and every changed spec or export against the submission. A matching PR number or title is insufficient. Squash and rebase merges may change commit identity, but the accepted bytes and exported relationships must match. Recover uncertain submissions using their existing operation identity instead of opening a new PR.

Checkpoint tags also have an authorization cutoff. Before creating a tag, the board locks its source notes, checks their current content, visibility, admission and moderation status, and commits an audit event containing the exact manifest, repository head and administrator identity. GitHub receives that recorded manifest. Later source edits affect the next checkpoint; hiding or changing a source before this transaction commits prevents the cut. Advisory results are cached against source content and identity as well as the repository head.

Published namespace maps use the same source checks and retain the exact authorized document and destination in their audit event. Maps include only admitted, currently public notes. A map refresh uses its own random branch, so it cannot reset an unrelated branch or adopt an unrelated pull request.

## When a replacement takes effect

Only a verified merge receipt changes which spec owns a requirement or retires a spec. A pending replacement remains visible alongside the current spec. Closing or abandoning an unmerged change leaves the current requirements in force. Accepting only part of a proposal requires a valid smaller change. Opening one participant's PR cannot trigger retirement of the rest.

When all affected specs are in one repository, publish their edits, historical stubs and metadata in one reviewed transaction. Changes across repositories need fixed versions of each participant and a separate protocol for when they take effect. Git cannot merge those repositories atomically.

For example, suppose a document's original PR has merged and an author edits its live `supersedes` to name another predecessor. Checking `live.supersedes` against that old merged PR could retire a spec even though the new relationship never merged. Retirement must read the relationships saved in the relevant merge receipt.

An edit to only `depends-on` or `supersedes` changes the candidate and requires fresh quorum. Published graph relationships come from verified merge receipts, while the live note can continue to propose different relationships. A pending replacement does not hide its predecessor. Cross-project retirement is disabled, including references expressed as note IDs.

Retirement records retain their source submission and merged commit. Administrators can reverse a retirement through `POST /admin/specs/:noteId/unretire`, with the current session's CSRF value and a `reason` form field. The reversal is audited and prevents later polling from reapplying that same submission. Existing `superseded_at` values without a verified receipt are retained in the database as unverified historical evidence; they do not hide the specification or disable revisions. Operators must verify those historical decisions explicitly rather than reconstructing intent from current frontmatter.

## Implementation and migration

1. Retain the local relation checks in parsing, cards and the API, and in publication preconditions. Preserve valid legacy lists, strings and numeric refs, report malformed values, and retain related pairs in advisory consistency review.
2. Preserve existing published bodies and their hashes. New service submissions always use the security metadata envelope. The larger proposed `publication-format: contract-v1` format still needs a separate structural validator and explicit migration.
3. Store submission and merge receipts and verify the accepted files and metadata. Preserve every historical export's format and hash. Adoption requires an explicit reviewed change. Never recalculate old approval or publication snapshots under the new format.
4. Use merge receipts to determine which relationships apply and which specs retire. Keep missing-evidence records as unverified, inactive historical evidence. Do not infer past intent from live frontmatter.
5. Retain submission, approval and publication evidence when a published note is deleted. Sensitive content requires the separate audited offline redaction workflow; deletion must not erase publication identity or approval hashes.
6. Multi-contract changes and partial replacements remain future work. The single-note candidate and fresh-quorum rules also apply to any later format.

## Acceptance cases

| Case | Required behavior |
| --- | --- |
| Invalid relation, unknown identity or empty required selection | Show a structural diagnostic and withhold publication; allow drafting. |
| Related contracts disagree | Keep the pair reviewable. A dependency does not establish consistency. |
| Only semantic metadata changes | Change the candidate, preserve old reviewer evidence and require fresh quorum. |
| Replacement is open or abandoned | Keep the predecessor effective without a retirement event. |
| Verified merge or recovered merge | Apply the exact exported relationships once; repeated processing is idempotent. |
| Live relation changes beneath a merged original PR | Keep the graph recorded in the relevant merge receipt. |
| Wrong target, extra changed contract or mismatched artifact hash | Fail submission/merge verification without partial activation. |
| Format support is enabled on an existing project | Avoid mass publication, hash rewrites and fabricated historical reviews. |
| Fresh edit within a round versus deliberate reopen | Changed candidates cannot use old approval credit; deliberate reopen also ends the prior approval round. |
| Editor changes or retracts during a publication tick | Re-read under the final claim's locks and reject the stale candidate before authorization commits. |
| Editor changes after authorization commits | Publish only the exact durable authorized bytes; require a new candidate for the edit. |
| GitHub login is renamed or reused | Preserve authority with the immutable account ID; a new account receives none of the former account's roles. |

Reviewers decide whether the inventory is complete, transfers preserve meaning, withdrawals are justified and a constitutional rule is useful. Project configuration supplies rules, namespaces and branding; standalone SpecDoc defaults remain generic.
