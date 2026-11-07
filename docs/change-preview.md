# specification change preview

A change bundle describes a proposed handoff between specification documents.
The preview reads the bundle's local sources, shows their diffs and checks the
declared obligation transfers, capabilities, relations and rules. It changes no
files, approvals, publication or retirement state; those follow the
[specification change process](spec-change-process.md).

```sh
specdoc context preview --config change.json --format json
specdoc context preview --config change.json --require-valid --max-tokens 20000
specdoc schema context.preview --format json
```

The preview works offline, without the optional native symbol-index
dependencies, and runs no check commands or project scripts. The MCP `preview`
tool takes the same `config`, `require_valid` and `max_tokens` inputs and skips
the board and index refresh. It reads only inside the configured repository and
`SPECDOC_ALLOWED_ROOTS` ([configuration](configuration.md#specdoc-mcp)) and
refuses Git repositories that configure filters, config includes or object
alternates.

Any `error` diagnostic makes `structurallyValid` false. A normal preview still
returns the packet; `--require-valid` fails with `INVALID_CHANGE` instead and
keeps the packet in the error. Structural checks cover only the declared
inputs. They cannot show that a transfer preserves behavior (IP conversion can
move to a validation rule that never defines conversion), that the change is
approved or that code conforms. The packet always reports `readOnly: true`,
`publicationAttempted: false`, `semanticPreservationVerified: false` and
`authorityVerified: false`.

## sources

The bundle names its sources and the obligations the change affects. Paths
resolve relative to the bundle file. Replace the placeholders with full Git
commit IDs and SHA-256 values.

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

Whatever the sources contain, this bundle reports at least two errors:
`INVENTORY_NOT_REVIEWED`, because `inventory.reviewed` is false, and
`MISSING_CAPABILITY`, because nothing provides `document.decode`.

Every source sets both `base` and `candidate`, and at least one must be
non-null: `base: null` is an addition, `candidate: null` a proposed removal.
Either side can be a Git snapshot: a local repository, a full commit ID and a
repository-relative file path. A candidate can instead be a local regular file
with its expected `sha256`. Uncommitted edits in a checkout never replace a Git
snapshot's bytes.

The packet records each Git source's commit, blob, path and SHA-256. A Git
source must be a regular file in its commit, not a symlink, directory or
submodule. A local file must be a regular file with no symlink in its path; it
is read once and must match its `sha256`. A source that is missing or fails
these checks stops the preview with `INVALID_CHANGE_SOURCE`. Git replacement
refs are ignored, and `GIT_NO_LAZY_FETCH` disables fetching objects missing
from a partial clone. Git honors that variable from 2.45, and from 2.39.4,
2.40.2, 2.41.1, 2.42.2, 2.43.4 and 2.44.1 on their maintenance lines; earlier
releases can still fetch.

A Git snapshot may name a local `currentRef`. If that ref no longer points at
the pinned commit, the preview reports a `BASE_REF_MOVED` error. Separately, a
checkout whose `HEAD` differs from the pinned commit gets a `HEAD_DIFFERS`
warning. The preview reads the pinned commit in both cases and never fetches or
rebases a ref.

An optional `reference` records a source's publication identity, `owner/repo#N`
or a name starting with a letter, and is never derived from a filename.
Selectors, capabilities and relations accept a source's `id` or `reference`; a
name that matches several sources is `AMBIGUOUS_REFERENCE`. Labels are scoped
to their source, so `FR-001` can appear in two documents but not twice in one
(`DUPLICATE_LABEL`).

## obligations

A selector picks one `FR-` or `SC-` label or an exact line range:

```json
{"source": "original", "selector": {"startLine": 19, "endLine": 21}}
```

`from` selectors resolve against the base and `to` selectors against the
candidate; the packet returns each selected excerpt with its source identity.
Labels come from top-level list items that begin with `FR-` or `SC-` and a
number, at most 512 per source. A base label is affected when the candidate
drops or repeats it, or changes its list item or the text of the sections
containing it. Each affected label needs exactly one disposition
(`UNASSIGNED_OBLIGATION` if missing), and one line range may cover at most one
affected label. Removing a source affects all of its labels.

`retained`, `moved` and `amended` need at least one destination in `to`, and
`split` needs two or more. `deferred` and `withdrawn` take none. A deferral
needs `owner` and `rationale` and is always a `DEFERRED_OBLIGATION` error, as
the obligation stays unresolved. A withdrawal needs `rationale` and reports a
`WITHDRAWAL_NEEDS_REVIEW` warning.

Obligations in stories, scope paragraphs, defaults or exclusions carry no label;
add line-range dispositions for them. Set `inventory.reviewed: true` once
someone has checked the documents for such obligations; until then the preview
reports `INVENTORY_NOT_REVIEWED`. `reviewedBy` is free text.

## capabilities and relations

A provider declares a capability with a selector into its candidate:

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

A requirement is met only by a `provides` entry for its capability; an existing
document without one leaves it `MISSING_CAPABILITY`. Providers and consumers
need a candidate, so a proposed removal can be neither. With several providers,
set `provider`, or the preview reports `AMBIGUOUS_CAPABILITY`.

A relation has a `type`, a `from` source with a candidate and a `to` source.
Malformed, unresolved and repeated relations are errors (`INVALID_RELATION`,
`UNRESOLVED_RELATION`, `DUPLICATE_RELATION`).

| type | `to` can be a proposed removal | cycle | in `consistencyReview` |
|---|---|---|---|
| `normative` | yes | warning | yes |
| `implementation` | no | error | yes |
| `publication` | no | error | no |
| `supersedes` | yes | error | yes |

Publication cycles need a separately reviewed coordination design.
`consistencyReview` lists related pairs whose requirements a reviewer should
compare.

Candidate frontmatter adds relations: each `depends-on` entry becomes an
`implementation` relation from that source, and `supersedes` becomes a
`supersedes` relation. Values must be strings that name a bundle source by `id`
or `reference`, with at most 512 `depends-on` entries; numeric shorthands such
as `supersedes: 12` are `INVALID_RELATION`. A relation declared both in
frontmatter and in `relations` is `DUPLICATE_RELATION`.

## rules and exceptions

A `forbid-relation` rule reports `FORBIDDEN_RELATION` for each relation of its
`relation` type from a `from` source to a `to` source, including relations from
frontmatter; it does not read code or Cargo manifests. `governing` selects the
candidate excerpt that states the rule. `governing`, `from` and `to` name
candidate sources by `id`. An empty `from` or `to` fails the rule unless it
sets `required: false`. The preview has no built-in rules; `model-boundary`
below is an example.

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
  ],
  "exceptions": [
    {
      "rule": "model-boundary",
      "version": "VERSION_FROM_RULE_CHECKS",
      "scope": ["model"],
      "stage": "foundation",
      "owner": "model maintainers",
      "rationale": "Decoding moves out of the model in the next stage.",
      "decision": "example/specs#16",
      "expires": "2026-12-31"
    }
  ]
}
```

An exception records an accepted violation; the violation stays an error. The
fields shown are required, except that `revisit` can replace `expires`
(`YYYY-MM-DD`) or accompany it. Copy `version` from the rule's
`ruleChecks[].version` after a first preview. It hashes the rule and its
governing source, so editing either invalidates the exception. `scope` is a
nonempty subset of the rule's `from` and `to`, `stage` must match the bundle's
`stage`, and `expires` needs the bundle's `asOf` and must not be earlier.
Mismatches and expired exceptions are errors, and even a valid exception
reports an `EXCEPTION_AUTHORITY_UNVERIFIED` warning.

## output and limits

CLI JSON returns the packet under `data`. MCP returns the text summary in
`content` and the packet, minus its `text` field, in `structuredContent`. An
`INVALID_CHANGE` error keeps the packet in CLI `error.details.packet` or in MCP
`structuredContent` with `isError: true`. The packet holds source identities,
full diffs, selected excerpts, obligation, capability and relation results,
rule checks and diagnostics; the text summary lists only the changes,
dispositions and diagnostics.

`max_tokens` defaults to 6,000 and accepts 500 to 32,000. The estimate counts
the compact JSON packet, including the CLI envelope, at four characters per
token; MCP transport framing is not counted. The preview returns the whole
packet or fails with `BUDGET_TOO_SMALL` and the required budget. It never clips
a diff, excerpt or diagnostic; narrow the bundle or raise the budget instead.

A bundle holds at most 32 sources, 512 dispositions, 256 provisions, 256
capability requirements, 512 relations, 64 rules and 64 exceptions. The bundle
file can be up to 512 KiB and each source up to 256 KiB. A whole-file addition
or removal puts the entire file in its diff, so at the 32,000-token maximum it
fits only up to about 118 KiB of typical Markdown; larger sources fit when the
diff is small.

The packet `id` hashes only the normalized bundle declaration
(`identityScope: normalized-bundle-declaration`), not the observed source state
or the results.
