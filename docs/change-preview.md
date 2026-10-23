# Preview specification changes

Use a change bundle to review a proposed handoff between specification documents.
The preview reads explicit local sources, shows their diffs and checks declared
obligation transfers, capabilities and relationships. It leaves source files,
approvals, publication and retirement unchanged.

```sh
specdoc context preview --config change.json --format json
specdoc context preview --config change.json --require-valid --max-tokens 20000
specdoc schema context.preview --format json
```

The command works offline without the optional native symbol-index dependencies.
It does not contact the board, fetch missing Git objects, execute check commands
or load project scripts. The MCP `preview` tool accepts the same `config`,
`require_valid` and `max_tokens` inputs, and bypasses board/index refresh.

`--require-valid` rejects structural findings with `INVALID_CHANGE`, preserving
the diagnostic packet. A normal preview returns the findings for inspection.
**Structural validity never establishes semantic preservation, approval or
implementation conformance.**

## Describe the change

The configuration names sources and the obligations affected by the proposed
change. Paths resolve relative to the JSON file. Replace the commit and hash
placeholders below with full Git commit IDs and SHA-256 values.

```json
{
  "schemaVersion": 1,
  "title": "Separate representation and decoding",
  "inventory": {
    "reviewed": false,
    "notes": "Review stories, defaults and exclusions as well as labeled rules."
  },
  "sources": [
    {
      "id": "original",
      "reference": "example/specs#15",
      "base": {
        "repository": "../requirements",
        "revision": "FULL_COMMIT_ID",
        "path": "specs/model.md"
      },
      "candidate": null
    },
    {
      "id": "model",
      "base": null,
      "candidate": {
        "file": "drafts/model.md",
        "sha256": "SHA256_OF_CANDIDATE"
      }
    }
  ],
  "obligations": [
    {
      "id": "original-model",
      "from": {"source": "original", "selector": {"label": "FR-001"}},
      "disposition": "moved",
      "to": [{"source": "model", "selector": {"label": "FR-001"}}]
    }
  ],
  "provides": [],
  "requires": [{"capability": "document.decode", "consumer": "model"}],
  "relations": [{"type": "supersedes", "from": "model", "to": "original"}]
}
```

Both `base` and `candidate` are explicit. A Git snapshot requires a local
repository, full commit ID and repository-relative file path. A candidate can
instead use a local regular file and its expected SHA-256. `base: null` describes
an addition; `candidate: null` describes a proposed removal. It does not remove
the file or make the replacement effective. A candidate Git snapshot has the
same shape as a base snapshot; dirty working files do not replace its bytes.

Git sources retain commit, blob, path and content identity. Symlink entries and
nonregular sources are rejected. Local candidates are read once into a bounded
buffer and checked against the expected hash. Replacement refs and implicit
object fetching are disabled. Missing or changed sources remain errors.

A Git snapshot can optionally declare `currentRef`. A mismatch between that
local ref and the pinned commit is a structural finding. Otherwise a different
working checkout HEAD is reported as a warning while the selected bytes stay
pinned. No ref is fetched or silently rebased.

An optional `reference` is an explicit publication identity, never a number
inferred from the filename. Source IDs qualify local labels: `FR-001` in two
documents is ordinary; two `FR-001` labels within the same document are ambiguous.

## Account for affected obligations

Selectors identify a unique FR/SC label or an exact source line range:

```json
{"source": "original", "selector": {"startLine": 19, "endLine": 21}}
```

The preview returns exact selected excerpts and source identities. Origin
selectors resolve against base snapshots; destinations resolve against candidate
snapshots. Every changed or removed recognized base obligation needs a
disposition. Unchanged provider documents do not need duplicate inventories.
Removing a whole source requires accounting for all its recognized labels.

Supported dispositions are `retained`, `moved`, `amended`, `split`, `deferred`
and `withdrawn`. A split names multiple destinations. A deferral names an owner
and rationale and remains unresolved. A withdrawal records rationale without
establishing authorization to withdraw the requirement.

The FR/SC scanner is a navigation aid. It cannot establish that an inventory
includes every obligation in stories, scope paragraphs, defaults or exclusions.
Add line-selected obligations for those cases. `inventory.reviewed` records the
caller's assertion; `reviewedBy` is descriptive metadata, not authenticated
approval. An unreviewed inventory remains a structural finding.

Even a fully connected transfer can be wrong. Mapping IP conversion to a
validation rule that never defines conversion resolves a target but does not
preserve the old behavior. The packet always reports
`semanticPreservationVerified: false` and `authorityVerified: false`.

## Check capabilities and relationships

Providers need an explicit capability and candidate source excerpt:

```json
{
  "provides": [
    {"capability": "document.decode", "source": "decoder", "selector": {"label": "FR-001"}}
  ],
  "requires": [
    {"capability": "document.decode", "consumer": "model", "provider": "decoder"}
  ]
}
```

An existing document path does not satisfy an absent capability. Candidate-null
sources cannot provide current behavior. Provider declarations remain assertions
for semantic review. Where several providers exist, select the intended provider
for the consumer.

Relations use explicit `type`, `from` and `to` fields. Types are `normative`,
`implementation`, `publication` and `supersedes`. Malformed or unresolved edges
are diagnosed rather than discarded. Implementation cycles block the selected
handoff; normative cycles are advisory review candidates. Publication cycles
need an explicit coordination decision. Supersession edges remain proposals.
Related pairs stay visible for consistency review; a dependency is not evidence
that the two contracts agree.

## Keep rule checks narrow

Optional `forbid-relation` rules check the bundle's declared relationships.
They name a governing source excerpt, relation type and selected `from`/`to`
sources. Required rules selecting no inputs fail. These checks do not discover
Cargo dependencies or prove architectural compliance in implementation code.

```json
{
  "stage": "foundation",
  "asOf": "2026-10-23",
  "rules": [
    {
      "id": "model-boundary",
      "governing": {"source": "constitution", "selector": {"startLine": 3, "endLine": 5}},
      "type": "forbid-relation",
      "relation": "implementation",
      "from": ["model"],
      "to": ["decoder"],
      "required": true
    }
  ]
}
```

The selected sources must exist in the candidate. The source range above is an
example of a caller-selected rule, not a built-in architectural policy. Choose
the assessment date explicitly when checking time-limited declarations.

Each rule check exposes a version derived from its declaration and governing
evidence. Exception records name that version, scope, stage, owner, rationale,
decision reference and expiry or revisit condition. Date checks use the bundle's
explicit `asOf` date. Invalid versions, scope or expiry remain findings. Valid
exception declarations remain unverified and do not erase forbidden-relation
findings. This preview does not authenticate exception decisions.

An exception has fields `rule`, `version`, `scope`, `stage`, `owner`,
`rationale`, `decision`, and at least one of `expires` (a `YYYY-MM-DD` date) or
`revisit`. First preview the rule and copy its `ruleChecks[].version` into the
declaration. `scope` is a nonempty subset of that rule's selected source IDs;
`stage` must match the bundle's stage. Adding an exception does not change the
rule version or clear its findings.

## Read the complete result

CLI JSON returns the packet under `data`. MCP returns the readable summary in
`content` and the same packet without duplicate `text` in `structuredContent`.
Strict errors retain the packet under CLI `error.details.packet` or MCP
`structuredContent` with `isError: true`.

The packet contains source identities, complete diffs, obligation evidence,
capability and relationship findings, rule checks and diagnostics. The text view
summarizes the result; use JSON to inspect the complete structured evidence.
`readOnly: true` and `publicationAttempted: false` describe the operation's
effects, not a lifecycle status.

The default budget is 6,000 estimated tokens, allowed range 500–32,000. It counts
compact serialized JSON, including the CLI envelope, at four characters per
token. This is an estimate, not a model tokenizer measurement. The preview
returns the whole selected packet or `BUDGET_TOO_SMALL` with the required budget;
it never clips a diff, source excerpt or blocking diagnostic to fit. Narrow the
bundle or increase the budget. MCP transport framing is outside this budget.

The bundle is limited to 32 sources, 512 disposition records, 256 provisions,
256 capability requirements, 512 relations, and 64 rules or exceptions. Each
source is at most 256 KiB; the configuration is at most 512 KiB. These bounds
do not guarantee that every maximum-sized combination fits the output budget.
Each source permits at most 512 recognized labels and each frontmatter
`depends-on` list at most 512 entries.
`id` identifies the normalized bundle declaration; observed source state and
diagnostics remain separate facts, as stated by `identityScope`.

Use the preview to prepare a reviewable change. Publication, approval freshness,
effective supersession and cross-repository activation continue to follow the
project's existing process.
