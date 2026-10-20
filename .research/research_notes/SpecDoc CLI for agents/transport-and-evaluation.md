# SpecDoc CLI transport choices and evaluation

Research retrieved **2026-10-20**. Scope: interface architecture and evidence for choosing a CLI, retaining MCP where useful, and measuring the result. This is research and a proposed evaluation design, not benchmark results. Source IDs below are local to this note. Versioned MCP references use **2026-07-28**; living documentation and repository `main` references describe the retrieved snapshot, not a pinned release.

## When should an agent use a CLI rather than MCP?

### Takeaway

A SpecDoc CLI is a reasonable default for agents that already execute subprocesses and manipulate local files. MCP remains useful for hosts that expose remote tools but cannot install or run a CLI. The important design decision is the operation contract; the interface carrying that contract should be replaceable.

### Cited Findings

- **T1 — MCP transports, revision 2026-07-28:** MCP supports stdio and Streamable HTTP. Stdio launches a subprocess and exchanges JSON-RPC messages over stdin/stdout, reserving stderr for logging. A local MCP integration therefore also has executable installation and process configuration concerns; MCP does not necessarily imply a separately deployed network service. [Transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio).
- **T2 — MCP changelog, revision 2026-07-28:** this revision removes protocol-level sessions and the initialization handshake, moves capabilities/version into request metadata, and adds `server/discover`. It also removes response-stream resumability: a broken stream requires a new request. Descriptions of mandatory session setup based on the 2025 specification do not characterize this revision. Actual installed clients and SDKs still need compatibility checks. [Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
- **T3 — MCP Tools, revision 2026-07-28:** MCP defines tool discovery, input/output schemas, structured results, and separate protocol versus tool-execution errors. It requires input validation and access controls. These are valuable integration conventions, not a specification of SpecDoc's revision checks, permissions, or editing semantics. [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- **T4 — Anthropic engineering, 2025-11-04:** the vendor describes loading tool definitions on demand and filtering intermediate results in code before returning them to a model. Its example retains MCP underneath the code interface. This supports progressive discovery and composition as design techniques; the article's illustrative token reduction is not a controlled CLI-versus-MCP experiment. [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
- **T5 — GitHub CLI, living manual:** `gh api` accepts request bodies from files/stdin, supports explicit pagination, and filters output using `--jq`. This is a concrete maintained interface showing how service operations compose with local programs. It does not establish comparative agent success rates. [gh api](https://cli.github.com/manual/gh_api).

### Inferences

**Recommendation:** expose one shared application/client layer through a CLI and a thin MCP adapter. That layer owns resource resolution, authentication context, request validation, revision preconditions, retry classification, and result/error types. The CLI owns argument parsing, stdin/files, stdout/stderr, and exit status; MCP owns its protocol mapping. Do not route every CLI call through a locally started MCP server merely to reuse domain logic.

Keep transport and semantic operations separate. A CLI can call remote HTTP APIs, while MCP can run entirely locally. Neither alone guarantees idempotency or safe edits. “Replace MCP” should mean removing an unnecessary integration requirement from shell workflows, not deleting an integration useful to other hosts.

This tradeoff matrix is a proposed decision aid, inferred from T1–T5:

| Concern | CLI with direct service access | MCP adapter |
|---|---|---|
| Agent already has shell access | Reuses subprocess/filesystem interface | Requires host MCP configuration |
| Host cannot execute local programs | Needs an execution service or is unavailable | Remote HTTP tool integration can fit |
| Distribution | Install, executable discovery, runtime/platform compatibility | Stdio has similar costs; remote server moves runtime operations elsewhere |
| Authentication | CLI must provide login, profiles, credential storage and refresh | Host may manage connection/auth UI; server still enforces access |
| Discovery | Hierarchical help and per-operation schemas | Standard tools/list and schemas; host decides what enters context |
| Composition | Files, pipes and scripts can avoid model-mediated copying | Code execution can do the same; direct-call hosts may expose each intermediate result |
| Observability | Explicit request IDs, stderr diagnostics, exit codes | Standard protocol envelopes plus application-level traces |
| Long-lived interaction | Requires explicit process/state design | Protocol features can support richer host integration, version dependent |

Avoid a false “terminal has no overhead” argument. A CLI may incur startup cost per command; stdio MCP may reuse a subprocess. Conversely, a CLI may be a small executable or reuse a daemon. Resource ownership and measurements determine the answer.

### Gaps

No inspected primary source establishes that a SpecDoc CLI will universally be faster, cheaper, or more reliable than its MCP interface. Host capabilities, tool-loading behavior, process startup, network latency, and output size must be measured separately. MCP 2026 protocol support in the actual target agents was not verified here.

## What makes the resulting interface useful and bounded for agents?

### Takeaway

Choose a small set of meaningful operations with concise, recoverable feedback. Bound discovery and results, preserve identity and provenance, and keep remote note text outside the authority of command execution.

### Cited Findings

- **T6 — Yang et al., SWE-agent, arXiv:2405.15793v3, 2024:** the paper studies an agent-computer interface with simple actions, compact operations, concise state feedback, and editing guardrails. Its shell-baseline ablation favors the tailored interface on the studied coding tasks. The result supports testing interface design, not a conclusion about MCP or present-day document agents. [Paper, §§2–5](https://arxiv.org/html/2405.15793v3).
- **T7 — Anthropic engineering, 2025-09-11:** the vendor recommends realistic multi-operation tasks, verifiable outcomes, held-out evaluations, and recording runtime, tokens, calls, and tool errors. It cautions against exposing every underlying API operation without considering agent workflows. These are practitioner recommendations derived from internal evaluations. [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- **T8 — Google Workspace CLI, retrieved `main`:** `gws` documents JSON results, per-method `schema`, dry-run, NDJSON pagination, several authentication methods, and distinct error exit codes. Its command surface is built from API discovery; the README warns of breaking changes before v1.0 and says the project is not an officially supported Google product. It illustrates useful discovery mechanisms and the compatibility cost of dynamic surfaces. [README](https://raw.githubusercontent.com/googleworkspace/cli/main/README.md).
- **T9 — Vercel Labs agent-browser, retrieved `main`:** the project documents compact snapshots, references to observed elements, configurable output limits, untrusted-content delimiters, and action/domain policies. Its CLI fronts a persistent daemon. These are implementation examples; neither bounded output nor delimiters prove immunity to prompt injection. [README, Security, Snapshot Options and Architecture](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/README.md).

### Inferences

Recommended SpecDoc principles:

1. **Progressive discovery:** short top-level help, then operation help/schema on demand. Publish a small workflow guide that agents can load when needed. Avoid making agents ingest every endpoint and schema before the first read. Adopt the useful `gws schema` idea without making the stable command vocabulary silently change whenever the server adds routes.
2. **Bounded observation:** search should return IDs, titles, canonical URLs, revision identifiers, and limited excerpts. Detail reads should expose explicit section/size controls, truncation metadata, and continuation. Give agents enough evidence to choose an exact document without automatically returning an entire workspace.
3. **Useful actions:** separate read, direct edit, suggestion, and discussion reply. A suggestion is not a successful direct edit. A command should return the resulting resource identity, revision or suggestion ID, canonical link, and requested operation's actual outcome. Do not make callers reconstruct these facts from prose.
4. **Trust boundaries:** treat titles, Markdown, comments, suggestions, and server error bodies as untrusted data. Preserve the origin and note/revision identity in a structured envelope; escape terminal control sequences in human rendering. Never evaluate note contents, interpolate them into shell syntax, or interpret a note's “next command” as authorization. Delimiters help recognition but do not enforce permissions.
5. **Bounded authority:** enforce scopes and target permissions on the server, independent of CLI flags. Keep bot and human identity visible. Do not allow a convenience fallback to silently change principal, instance, or write mechanism.
6. **Compatibility:** version the executable and machine-output contract explicitly; expose supported operations/capabilities; pin releases in automation. Treat changes to error meanings, default pagination, identity resolution, and mutation preconditions as compatibility changes. An unknown required capability should fail clearly before a write.

The shared layer recommendation is architectural inference, not a result measured in T6–T9. Its proposed benefit is preventing semantic drift: a stale-revision edit must have the same rejection behavior through CLI and MCP. Adapter contract tests can verify that property.

### Gaps

Source examples do not establish the correct SpecDoc command count, page size, context budget, or output format defaults. Those depend on real document sizes and workflows. A compact response can omit decisive context; output reduction must be evaluated alongside correctness and recovery.

## How should SpecDoc evaluate the CLI proposal?

### Takeaway

Compare complete workflows using identical server semantics and credentials, then isolate discovery and transport costs. Correct target selection and safe mutation outcomes are release gates; performance gains remain hypotheses until measured.

### Cited Findings

T7 recommends task-level verifiers and held-out evaluation rather than overfitting an expected tool sequence. T6 shows that concise feedback and action design can change agent performance. T4 demonstrates that intermediate-result filtering is available even when MCP remains underneath. Together they motivate a fair comparison of interfaces, not a comparison of an optimized CLI with deliberately verbose MCP. [T7](https://www.anthropic.com/engineering/writing-tools-for-agents), [T6](https://arxiv.org/html/2405.15793v3), [T4](https://www.anthropic.com/engineering/code-execution-with-mcp).

### Inferences

**Proposed evaluation setup:** use disposable fixtures and a fixed server snapshot. Compare (A) current MCP behavior, (B) CLI with shared operation contracts, and, when supported, (C) MCP with deferred discovery/code composition. Record model and harness versions, protocol/SDK versions, permissions, network conditions, command/output schemas, and cold versus warm execution. Keep task prompts and reachable operations equivalent; otherwise report differences as product capability gaps.

| Workflow | Fixture and observable acceptance result |
|---|---|
| Find/read the exact spec | Similar titles, aliases and multiple versions; agent returns the intended note ID, canonical URL and relevant requirement from the correct revision |
| Append requirement | Read revision, inject a concurrent edit, attempt append; stale write is rejected without losing either user's content; retry rereads and makes only the requested change |
| Submit bot suggestion | Distinct bot principal and suggestion permissions; exactly one suggestion has the intended body/target and is reported as a suggestion, with its ID |
| Reply to a thread | Several similar threads; exactly one reply lands on the intended thread, with correct actor attribution |
| Retrieve context/trace | Linked requirements, discussions and origins; result preserves source IDs/revisions, explains truncation, and remains within configured bounds |
| Timeout after possible commit | Drop the response after server commit; outcome is marked uncertain until reconciled; retry with the same operation identity does not create duplicates |

**Prioritized hypotheses and gates:**

- **P0 — mutation integrity:** deterministic fault-injection fixtures pass with zero wrong-target writes, lost concurrent updates, duplicate suggestions/replies, or false claims of success. A timeout without reliable reconciliation remains an explicit unknown outcome. This is a proposed gate, not a claim that the current API provides idempotency.
- **P0 — authority integrity:** hostile note text cannot change instance, principal, requested scope, or operation. Test permission denial, revoked credentials and forged command-like content. Assertions examine server effects and outgoing requests, not only the agent's answer.
- **P1 — usability:** measure complete-task success, recoverable-error success, unnecessary clarification count, and turns to completion across repeated independent trials. Include malformed IDs, empty search, pagination, missing permissions, and large documents.
- **P1 — efficiency:** report model input/output tokens, discovery tokens, result bytes, calls, retries and end-to-end latency. Separately report process startup, peak RSS, CPU time, network requests/bytes, and resident-process idle cost. Do not infer RAM savings from token savings.
- **P2 — operational fit:** from a clean environment, measure installation/login time, dependencies, configuration steps, upgrade compatibility, and whether non-shell hosts retain a working path.

Use a pilot to set explicit performance thresholds before comparing variants. Randomize variant order, separate cold and warm runs, preserve transcripts with secrets removed, and report trial counts and uncertainty. Do not optimize solely for fewer calls: one enormous response can cost more and yield worse target selection than two bounded reads. The release decision should retain correctness gates even if a variant wins on speed.

### Gaps

No benchmark was run, no paid agent trials were started, and no live document was modified. Server-level concurrency controls, durable operation identities, and reconciliation endpoints must first be confirmed or added; a CLI alone cannot manufacture those guarantees.
