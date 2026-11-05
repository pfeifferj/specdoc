# build and test context

`context build` lists the build, test and CI declarations in a checkout with
their source evidence. It runs none of them and returns a bounded part of the
graph instead of the whole repository.

```sh
specdoc context build --repo /path/to/application --format json
specdoc context build 'build:npm-script:package.json#test' \
  --repo /path/to/application --max-tokens 4000 --format json
```

Without an id, the command returns a bounded overview. An id copied from an
earlier response selects that node and its one-hop relationships; an unknown id
fails with `NOT_FOUND`. The MCP `build` tool takes the same `id`, `repo` and
`max_tokens` inputs. Its `repo` defaults to the server's checkout, and other
checkouts must be under `SPECDOC_ALLOWED_ROOTS`
([configuration](configuration.md#specdoc-mcp)). `context query` returns no
build data.

The command reads only local data: tracked files from the working tree and Git
metadata. It does not contact the board, fetch dependencies, run package
scripts, evaluate Make recipes, start runners or resolve GitHub expressions,
and the CLI does not need the optional native symbol-index dependencies. The
CLI runs Git with the checkout's own configuration, so a clean filter set in its
`.git/config` can run during `git status`; point the CLI only at checkouts with
trusted Git metadata. The MCP tool refuses checkouts that configure filters,
config includes or object alternates ([security](security.md)).

The graph records declarations only. It cannot show that a check builds,
passes, has run or covers a requirement; run checks in the project's own
environment with its prerequisites.

## declarations and evidence

| source | declared facts |
|---|---|
| `Cargo.toml` | workspaces, members matched by declared patterns, local path dependencies, integration-test targets declared in `[[test]]` or found under `tests/` |
| `package.json` | packages and literal npm script commands |
| `Makefile`, `makefile`, `GNUmakefile` | literal targets, pattern targets and prerequisite text |
| `.sh` and `.bash` files under a `test/` or `tests/` directory, or with a `# tags:` comment in the first ten lines | shell test paths and tags, split on commas or spaces (`# tags: build, meta`) |
| `.github/workflows/*.yml` and `*.yaml` | workflows, jobs, steps, static `needs` relationships, literal `run`, `uses`, conditions, environment declarations and run defaults |

Each fact's evidence gives the source path, a line range, the full `HEAD`
commit when there is one, the SHA-256 of the whole file as read from the
working tree and `basis: tracked-working-tree`. The hash covers uncommitted
edits to tracked files. TOML, JSON and workflow evidence spans the whole file;
Make targets and shell tags point at their own line. Symlinked, unreadable or
non-UTF-8 sources and files over 512 KiB become gaps.

The graph does not resolve registry dependencies, features, `cfg` conditions,
unit tests, implicit workspace membership or build scripts. Workspace member
patterns expand literal paths and single `*` wildcards; other patterns become
gaps. A test target's `available` flag means only that its tracked source was
readable.

Workflows are parsed with the YAML 1.2 core schema. Duplicate keys and tags
outside that schema make the file an `invalid-workflow` gap, and `<<` merge
keys become gaps without being expanded. Commands and `${{ }}` expressions stay
literal strings. A matrix job stays one template. Reusable workflows and
actions are not followed. `needs` edges record declared prerequisites, not
runnable jobs. Workflow, job and step environments and defaults stay separate,
and no effective environment is computed. Values nested deeper than a flat list
or mapping become gaps. Triggers, credentials, permissions, runner availability
and outcomes are not inferred.

## bounded packets

JSON responses contain a versioned `specdoc-build-packet` under `data`:

| field | meaning |
|---|---|
| `repository`, `revision`, `dirty`, `trackedOnly` | observed local source scope |
| `selection` | the node id used for one-hop filtering, if any |
| `nodes`, `edges` | whole declarations with their evidence; every delivered edge comes with both endpoint nodes |
| `gaps`, `limits` | unresolved declarations and extraction boundaries |
| `counts` | graph, selected and delivered totals |
| `omissions` | selected nodes, edges and gaps that did not fit |
| `complete` | everything selected was delivered and the selection has no gaps |
| `text` | a short summary of the delivered selection |

`dirty` is `null` when the checkout cannot be confirmed clean, including when
it contains uninspected submodules. Known changes still set it to `true`.
Submodule paths are listed as `submodule-not-inspected` gaps; the command does
not run Git in those nested repositories.

`max_tokens` accepts 500 to 20,000. The CLI defaults to 1,500; the MCP tool
defaults to `SPECDOC_MAX_TOKENS` (1,500 when unset or invalid), raised to 500
if lower.
The estimate counts the compact JSON packet, including `text` and the CLI
envelope, at four characters per token; MCP transport framing is not counted.
MCP returns the packet without `text` in `structuredContent` and the summary in
`content`.

Nodes, edges with their endpoints, and gaps are added whole or not at all;
commands and evidence are never shortened. To see more, narrow to a returned
node id or raise the budget. The call fails with `BUDGET_TOO_SMALL` when the
packet without facts, or the requested node with its evidence, does not fit.
The packet without facts needs about 487 tokens plus one token per two
characters of the repository path, which appears in both `repository` and
`text`, so at 500 tokens paths longer than about 27 characters fail.
