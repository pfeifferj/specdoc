# CLI interface contracts for SpecDoc agents

Research date: **2026-10-20**. All sources below were retrieved on that date. This is research and a proposed interface, not documentation of implemented SpecDoc commands. Source IDs C1–C9 form the evidence ledger; recommendations are separated from observed behavior.

## What should an agent discover, and how should it select results?

### Takeaway

Recommend a small, stable command tree with local help, inspectable input/output schemas, explicit JSON, and bounded list responses. Existing tools demonstrate these mechanisms; they do not establish one universally optimal agent interface.

### Cited Findings

- **C1 — GitHub CLI agent skill, current `trunk`, unversioned.** The project's own guidance recommends `--json` with selected fields and documents field discovery by omitting the field list. It warns that list limits are caps rather than totals; common list/search commands usually default to 30. Its non-TTY contract skips the pager and ANSI color and reports missing required input instead of prompting. This is maintainer guidance for actual CLI behavior, not an independent performance study. — [GitHub CLI agent skill](https://raw.githubusercontent.com/cli/cli/trunk/skills/gh/SKILL.md)
- **C2 — Google Workspace CLI README, current `main`, pre-v1.** `gws schema drive.files.list` introspects request/response schemas. Commands are dynamically built from Discovery documents cached for 24 hours. `--page-all` emits one JSON object per page as NDJSON; it is off by default, with a default ten-page limit when used. The README explicitly says the project is not an officially supported Google product and warns of breaking changes before v1. This is a useful contemporary design example, not a stable Google platform standard. — [Google Workspace CLI README](https://raw.githubusercontent.com/googleworkspace/cli/main/README.md)
- **C3 — SWE-agent author documentation, `latest`, unversioned; linked research originates in 2024.** The authors describe improvements from a deliberately designed agent-computer interface, including edit-time validation, a file viewer displaying 100 lines, and succinct search results. They also add an explicit success message for otherwise empty tool output. These observations concern their software-engineering environment and experimental setup; they do not prove a universal 100-line limit or JSON preference. — [SWE-agent ACI documentation](https://swe-agent.com/latest/background/aci/)
- **C4 — gcloud format reference, updated 2026-10-06.** `--format`, projections, and filters provide explicit machine-readable output and selected resource keys. The documentation says unknown format attributes are silently ignored. That last behavior is a counterexample to strict validation, not a property to copy unquestioningly. — [gcloud formats](https://docs.cloud.google.com/sdk/gcloud/reference/topic/formats)

### Inferences

**Proposed discovery architecture.** Keep one command-description registry containing arguments, required fields, enum values, side-effect classification, input/output schemas, and examples. Generate parser definitions, human help, and machine discovery from it. Avoid maintaining a separate agent grammar. Schema availability should not require authentication or a healthy server. These are SpecDoc recommendations inspired by C1–C2, not claims that those tools share this architecture.

Use progressive discovery: top-level help lists resources and a few workflows; command help explains one operation; `schema` returns one operation's contract. Do not dump every endpoint schema into every agent session. Include CLI version and schema-contract version, and identify server capabilities separately. Dynamic API discovery has value, but SpecDoc should deliberately version its supported workflow commands rather than letting a server schema silently change them.

**Hypothetical commands:**

```sh
specdoc --help
specdoc document update --help
specdoc schema document.update --format json
specdoc document list --limit 20 --fields id,title,revision --format json
specdoc document get bR0-jQzDTtiBkdjuywpYEg --format markdown
```

Every JSON operation should have a documented default field set. List responses should omit full document bodies unless requested. A proposed envelope is:

```json
{
  "schemaVersion": 1,
  "data": [{"id": "doc-id", "title": "CLI specification", "revision": "rev-id"}],
  "page": {"nextCursor": "opaque-cursor", "complete": false}
}
```

Projection should operate inside `data`; it must not remove continuation metadata. Reject unknown field names before network access and distinguish omitted fields from explicit `null`. Prefer a short list of supported field paths over embedding a new query language in v1. Users can pipe JSON to `jq` when needed.

**Useful acceptance checks:** help and schema work offline; examples parse against the same registry; declared fields match runtime output; invalid fields are rejected; adding a server field does not change selected output; empty lists remain valid envelopes with explicit completion state.

### Gaps

- No reviewed source establishes that JSON always produces better agent outcomes than concise text. Treat explicit formats as interoperability choices and evaluate task completion locally.
- The optimal default page size, body excerpt size, and field set require SpecDoc workload measurements. Do not transplant SWE-agent's file-viewer limit.
- Decide whether machine discovery needs full JSON Schema immediately or a smaller typed descriptor first. Schema drift prevention matters more than a particular serialization.

## How should output, input, and failures behave without a terminal?

### Takeaway

Recommend a deterministic machine contract: success data on stdout, errors on stderr, no implicit interaction, and explicit file/stdin inputs. Make raw Markdown a first-class output because reading and editing prose are core workflows.

### Cited Findings

- **C5 — AWS CLI v2 pagination guide, current `latest`, unversioned.** AWS retrieves all available items by default. `--page-size` changes service request size, not total output size; `--max-items` bounds output and can return `NextToken`. Its v2 pager defaults to the operating system's pager, with `--no-cli-pager` or empty configuration/environment values to disable it. These differ from the GH defaults in C1 and show why paging behavior must be explicit. — [AWS CLI pagination](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-pagination.html)
- **C6 — AWS structured error documentation, current `latest`, unversioned.** Errors go to stderr; `--cli-error-format json` exposes structured fields. Unknown-argument errors and keyboard interrupts still use legacy formatting. Therefore, even a mature CLI with JSON errors may not offer a uniform parser-error contract. — [AWS structured errors](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-error-format.html)
- **C7 — AWS return-code documentation, current `latest`, unversioned.** Code 2 means parse failure generally but skipped transfers for S3; 252 also covers invalid syntax/parameters, while 253 covers invalid configuration or credentials. In comparison, `gws` assigns 2 to authentication and 3 to validation. These are incompatible application contracts; numeric meanings cannot be inferred from another CLI. — [AWS return codes](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-returncodes.html); [C2](https://raw.githubusercontent.com/googleworkspace/cli/main/README.md)
- **C8 — GitHub CLI `issue create` manual, current, unversioned.** `--body-file` accepts a path or `-` for stdin. It documents partial attachment failure: the issue may still be created, its URL printed to stdout, and the command exit nonzero. A failed exit alone therefore does not universally mean no mutation occurred. — [gh issue create](https://cli.github.com/manual/gh_issue_create)

### Inferences

**Proposed format contract.** `--format json` should emit exactly one JSON document on successful finite operations, whether stdout is a TTY or pipe. `--format markdown` should emit the stored document content without a banner, metadata footer, syntax highlighting, or invented trailing newline. Human presentation may use a separate format. Explicit format flags should override configuration. Do not infer an agent from process names or hidden environment heuristics.

In JSON mode, route warnings and diagnostics into structured stderr records; suppress progress output unless requested. Keep success stdout parseable. For v1, prefer single-resource atomic commands and a single error object on failure. If batch or streaming commands arrive later, specify partial success and termination records before adding them. Do not claim rollback merely because exit status is nonzero.

**Hypothetical error, on stderr with empty stdout:**

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Unknown field: revison",
    "details": {"field": "revison", "allowed": ["id", "title", "revision"]}
  }
}
```

Use stable string codes for programmatic decisions and human-readable messages for diagnosis. A small initial exit table—0 success, 2 local usage/validation, 1 other failure—is sufficient if typed codes distinguish remediation. This is a design choice, not an asserted universal convention. Define parser errors in the same schema and handle format selection early enough that invalid commands still produce JSON when explicitly requested. Preserve normal interrupt semantics separately.

**Proposed input contract.** Use one explicit content channel: `--body-file PATH`, with `-` meaning stdin. Missing body arguments should fail immediately rather than reading stdin opportunistically or launching an editor. Reject conflicting input sources and validate encoding/size before mutation. Document UTF-8 and whether line endings and a final newline are preserved. Provide a separate JSON-file mechanism only for genuinely structured operations.

```sh
specdoc document update doc-id --body-file ./proposal.md --format json
specdoc document update doc-id --body-file - --format json < ./proposal.md
```

These examples are hypothetical and omit concurrency controls covered by the architecture research. Recommend file input for multiline Markdown containing quotes, backticks, `$()`, or fences; agent integrations should pass argv directly when possible. Never construct a shell command by interpolating the document body. Supporting `--` for operands and `--option=value` for option-like values should be part of parser tests.

No-TTY operation should never launch a pager, browser, editor, prompt, or spinner. An explicit noninteractive flag should enforce the same behavior even when an agent harness allocates a PTY. It must report missing information, not silently supply an answer.

**Useful acceptance checks:** compare JSON under pipes and PTYs; parse stdout with a strict JSON parser; test missing arguments and unknown options in JSON mode; verify no read from stdin without `--body-file -`; round-trip Markdown fixtures containing shell metacharacters, Unicode, CRLF, and no final newline; ensure failed preflight validation makes zero mutation requests.

### Gaps

- Uniform structured errors need parser-library verification. C6 demonstrates why inspecting the advertised API is insufficient.
- Decide how to represent warnings without forcing callers to parse mixed text/JSON stderr.
- The reviewed sources do not settle whether raw content and metadata belong in one read command or separate export/inspect commands. Both can work if explicit and consistent.

## How should pagination and parsing avoid silent changes?

### Takeaway

Recommend bounded traversal and exact canonical spellings for automation. Human shortcuts can be explicit aliases; arbitrary prefixes should not become the agent compatibility contract.

### Cited Findings

- **C9 — AWS troubleshooting, current `latest`, unversioned.** AWS accepts unambiguous parameter abbreviations through `argparse`, but explicitly warns against relying on them: new parameters can make old abbreviations ambiguous. It also documents last-value-wins behavior when a full flag and its abbreviation identify the same single-valued parameter. This evidence concerns option prefixes, not `ip`-style subcommand prefixes. — [AWS incomplete parameter names](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-troubleshooting.html)
- C5 warns that the underlying service may not return stable ordering, and mismatched page size/output limits can produce missing or duplicate items. Cursor handling alone does not establish snapshot consistency. — [C5](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-pagination.html)

### Inferences

Recommend `--limit` as the maximum items returned by one finite invocation, with a documented default and hard ceiling. Expose an opaque continuation cursor and an explicit completion indicator. Do not call a bounded list “all documents” or imply that returned count equals total count. Preserve cursor values exactly.

Keep backend page size internal initially. If export needs whole-collection traversal, add an explicit operation or `--all` with documented request/time limits and a completion report. Do not silently turn ordinary reads into unbounded loops. Use a separately selected NDJSON mode for streaming; specify whether each line is an item, page, or event, including how a later failure is reported.

Recommend strict parsing for commands, flags, enum values, and projection fields. Unknown tokens and duplicate single-valued flags should fail before any request. Do not auto-correct and execute. Reserve canonical names in documentation, machine schemas, and agent examples.

If desired for humans, fixed aliases such as `ls` can have explicit compatibility promises. Arbitrary shortest-prefix matching changes meaning as the command tree evolves; it adds little to an agent that can emit full command names. The earlier netfyr abbreviation proposal should not be treated as a SpecDoc requirement. If prefixes are eventually offered, document their instability and exact-name precedence separately.

**Useful acceptance checks:** a list larger than its limit reports continuation; the final page explicitly reports completion; invalid/expired cursors fail clearly; projection preserves paging metadata; a later streaming failure exits nonzero; new commands cannot change canonical invocations; misspellings and duplicate flags make zero network requests.

### Gaps

- Stable sorting, cursor expiration, concurrent inserts/deletes, and snapshot guarantees depend on the service API. These must be specified honestly rather than promised by the CLI alone.
- No cited research isolates shorter command names as a meaningful agent efficiency gain. Measure error rate, output volume, and total interactions before optimizing spelling.
- Source pages are moving documentation snapshots, not pinned release specifications. Recheck against selected dependency versions when implementation begins.
