# Specification change process

Proposal for review, 23 October 2026. The local changes have not been deployed.

Keep current requirements in merged Markdown specs. Review a short change proposal alongside the exact spec diff, then archive the proposal after merge. Include related documents in the same change when publishing them separately would leave a requirement without an owner.

## Implementation status

| Mechanism | State |
| --- | --- |
| Offline preview of sources, diffs, requirement transfers, capabilities and declared rules | Implemented locally; see [change preview](change-preview.md). |
| Visible malformed relation diagnostics and review of already-related pairs | Implemented locally. Invalid relations block publication and supersession actions. Legacy spellings and approval credit remain supported. |
| Published relationship metadata, records tied to the proposed content, and retirement after verified merge | Proposed here; not implemented. |
| Authenticated approvals, stale credit within a review round and voiding on deliberate reopen | Existing behavior; preserve it. |

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

The review interface shows the selected files at their recorded hashes. Save the candidate ID in the signed source or approval assertion so a file edit outside the note still appears as a content change. Keep each reviewer's snapshot when the candidate changes. Current policy allows earlier approvals to count after an edit within the same review round. The publication authorization record names the current candidate, policy revision and credited review receipts, including approvals of older content. It records which version each reviewer saw.

The original publication reference stays stable across revisions. Each revision gets its own submission and merge receipts; an original merged PR cannot authorize later edits. Check the merged tree and every changed spec or export against the submission. A matching PR number or title is insufficient. Squash and rebase merges may change commit identity, but the accepted bytes and exported relationships must match. Recover uncertain submissions using their existing operation identity instead of opening a new PR.

## When a replacement takes effect

Only a verified merge receipt changes which spec owns a requirement or retires a spec. A pending replacement remains visible alongside the current spec. Closing or abandoning an unmerged change leaves the current requirements in force. Accepting only part of a proposal requires a valid smaller change. Opening one participant's PR cannot trigger retirement of the rest.

When all affected specs are in one repository, publish their edits, historical stubs and metadata in one reviewed transaction. Changes across repositories need fixed versions of each participant and a separate protocol for when they take effect. Git cannot merge those repositories atomically.

For example, suppose a document's original PR has merged and an author edits its live `supersedes` to name another predecessor. Checking `live.supersedes` against that old merged PR could retire a spec even though the new relationship never merged. Retirement must read the relationships saved in the relevant merge receipt.

An edit to only `depends-on` or `supersedes` exposes another gap: the current published-body hash strips frontmatter, so the body fingerprint stays unchanged and the stale diff misses the metadata edit. In `contract-v1`, semantic metadata contributes to candidate and publication identity and to review comparison. The edit becomes visible while approval credit continues to follow current policy.

## Implementation and migration

1. Retain the local relation checks in parsing, cards and the API, and in publication preconditions. Preserve valid legacy lists, strings and numeric refs, report malformed values, and retain related pairs in advisory consistency review.
2. Add a versioned metadata reader/writer and independent structural validator. Proposed project setting `publication-format: contract-v1` enables support; `legacy` remains the default. Each export or adoption selects its format explicitly. Enabling support leaves existing exports and revision queues unchanged.
3. Store submission and merge receipts and verify the accepted files and metadata. Preserve every historical export's format and hash. Adoption requires an explicit reviewed change. Never recalculate old approval or publication snapshots under the new format.
4. Use merge receipts to determine which relationships apply and which specs retire. Check old records against known merged files and mark missing evidence `legacy-unverified`. Do not infer past intent from live frontmatter or silently revive retired records.
5. Support short changes that review and publish several contracts together. Preserve current approval policy until an explicit policy change replaces it.

## Acceptance cases

| Case | Required behavior |
| --- | --- |
| Invalid relation, unknown identity or empty required selection | Show a structural diagnostic and withhold publication; allow drafting. |
| Related contracts disagree | Keep the pair reviewable. A dependency does not establish consistency. |
| Only semantic metadata changes | Change the candidate/diff, preserve old reviewer snapshots and apply current stale-credit policy. |
| Replacement is open or abandoned | Keep the predecessor effective without a retirement event. |
| Verified merge or recovered merge | Apply the exact exported relationships once; repeated processing is idempotent. |
| Live relation changes beneath a merged original PR | Keep the graph recorded in the relevant merge receipt. |
| Wrong target, extra changed contract or mismatched artifact hash | Fail submission/merge verification without partial activation. |
| Format support is enabled on an existing project | Avoid mass publication, hash rewrites and fabricated historical reviews. |
| Fresh edit within a round versus deliberate reopen | Retain same-round stale credit; void approvals from the prior round on reopen. |

Reviewers decide whether the inventory is complete, transfers preserve meaning, withdrawals are justified and a constitutional rule is useful. Project configuration supplies rules, namespaces and branding; standalone SpecDoc defaults remain generic.
