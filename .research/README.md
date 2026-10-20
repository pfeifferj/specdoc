# SpecDoc CLI research

Research retrieved **2026-10-20**. Start with [Give SpecDoc agents a dependable CLI](reports/SpecDoc%20CLI%20for%20agents.md).

The report recommends a CLI over shared application operations, with MCP retained as an optional adapter. Routine HTTP operations should avoid checkout indexing. Author edits must preserve complete raw source and its exact editor ETag; bot suggestions remain a separate identity and workflow. Browser login should return authorization automatically through a local PKCE callback or a remote-friendly device flow.

The implementation now lives in [`cli/`](../cli), with browser device
authorization, shared MCP clients/context operations, and public mutation
receipts. The accepted design uses device authorization on every platform;
the loopback/PKCE option remains research, not an implemented fallback.
See [CLI usage](../docs/cli.md) and the [API contract](../docs/api.md).
The source notes preserve findings from before implementation. No deployment
or performance advantage is claimed by this research.

| Source note | Focus |
|---|---|
| [CLI contracts](research_notes/SpecDoc%20CLI%20for%20agents/cli-contracts.md) | Discovery, JSON/errors, stdin, pagination and strict parsing |
| [Repository architecture](research_notes/SpecDoc%20CLI%20for%20agents/specdoc-architecture.md) | Current APIs, identity, raw edits, concurrency, retry gaps and auth fit |
| [Transport and evaluation](research_notes/SpecDoc%20CLI%20for%20agents/transport-and-evaluation.md) | CLI/MCP tradeoffs, shared operations and measurable acceptance |
| [Browser login](research_notes/SpecDoc%20CLI%20for%20agents/browser-login.md) | Documented Codex/Claude behavior, local callback, device flow and storage |
