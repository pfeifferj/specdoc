# build and test context

Use build context to discover declared checks and their source evidence without
running them or loading a whole repository graph into an agent's context.

```sh
specdoc context build --repo /path/to/application --format json
specdoc context build 'build:npm-script:package.json#test' \
  --repo /path/to/application --max-tokens 4000 --format json
```

Copy node ids from an actual response. An optional id selects that node and its
one-hop relationships; an unknown id fails with `NOT_FOUND`. Without an id,
the command returns a bounded overview. The MCP `build` tool accepts the same
`id`, `repo` and `max_tokens` fields. `repo` defaults to the server's configured
checkout. Build discovery stays separate from `context query`; requirements
queries do not carry an unrestricted build graph.

The command reads tracked working-tree files and Git metadata locally. It does
not contact the board, fetch dependencies, execute package scripts, evaluate
Make recipes, start runners or resolve GitHub expressions. The CLI path also
works without optional native symbol-index dependencies.

## declarations and evidence

| source | declared facts |
|---|---|
| `Cargo.toml` | workspaces, explicitly matched members, local path dependencies, explicit and conventional integration-test targets |
| `package.json` | packages and literal npm script commands |
| Makefiles | literal targets, pattern targets and prerequisite text |
| shell tests | tracked test paths and tags declared within the first ten lines |
| `.github/workflows/*.yml` and `*.yaml` | workflows, jobs, steps, static `needs` relationships, literal `run`, `uses`, conditions, environment declarations and run defaults |

Facts carry source path, line range, full implementation revision when available,
SHA-256 of the exact complete source file, and `tracked-working-tree` provenance.
The hash identifies the working bytes even when `HEAD` has not changed. TOML,
JSON and workflow evidence uses complete-document ranges; the extractor does
not claim precise AST locations. Make targets and shell tags have line ranges.
Symlinked sources, unreadable files and files over 512 KiB become explicit gaps.

Cargo registry resolution, feature activation, `cfg` evaluation, unit-test
enumeration, implicit workspace membership and build-script effects are outside
this graph. Workspace patterns expand literal paths and single-star wildcards;
more complex patterns remain unresolved. Test-target availability means only
that its tracked source was readable. It does not establish that it builds or
passes.

Workflow YAML uses a real parser with CORE scalars. Duplicate keys and custom
tags fail parsing. Commands and expressions remain source strings. Matrices
stay job templates, reusable workflows and actions are not followed, and
`needs` edges record declared prerequisites rather than runnable jobs. Workflow,
job and step environments/defaults remain separate; the graph does not compute
an effective execution environment. Nested or cyclic values outside the
supported flat declarations become gaps. YAML merge declarations remain
unexpanded and are reported as gaps. Trigger activation, credentials,
permissions, runner availability and outcomes are not inferred.

## bounded packets

JSON responses contain a versioned `specdoc-build-packet` under `data`:

| field | meaning |
|---|---|
| `repository`, `revision`, `dirty`, `trackedOnly` | observed local source scope |
| `selection` | the optional exact node id used for one-hop filtering |
| `nodes`, `edges` | whole declarations and their complete evidence; delivered edges always have both endpoint nodes |
| `gaps`, `limits` | unresolved declarations and extraction boundaries |
| `counts` | repository graph totals, selected totals and delivered totals |
| `omissions` | counts of whole nodes, relationships and source gaps that did not fit |
| `complete` | the selected declarations fit and have no recorded source gaps; never a check result or conformance verdict |
| `text` | a short readable summary generated from the same limited selection |

`max_tokens` ranges from 500 to 20000 and defaults to 1500. The approximate
budget counts the compact serialized JSON packet, its summary and the CLI
envelope at four characters per token. This is a character estimate, not a
model tokenizer count. MCP returns the same selection as `structuredContent`
and the summary in `content`; it omits the redundant packet `text` field.
MCP transport framing and the outer host protocol are outside this budget.

Node/edge bundles and source gaps are admitted whole. Commands, evidence and
individual facts are never shortened to make them fit. Omission counts remain
visible. Narrow to a returned node id or increase the budget to retrieve more.
If provenance and limits, or an explicitly requested node with its evidence,
cannot fit, the call fails with `BUDGET_TOO_SMALL` instead of returning a partial
fact. The minimum baseline can exceed the allowed lower bound for a long
repository path.

Discovery tells an agent where a check is declared and what its source says.
Use the project's execution environment, prerequisites and evidence contracts
before running it. No relationship in this graph asserts that a requirement was
satisfied or that a check has run.
