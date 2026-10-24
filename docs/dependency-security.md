# dependency advisories

The October 2026 security update upgrades the board, CLI, MCP server and exposed
editor dependencies. It does not make the inherited editor dependency tree free
of advisories. This page records the remaining integration work and the code
paths reviewed; a package being unused in one configuration is not a patch.

The 24 October 2026 editor audit reports eight production advisories (seven
moderate, one low) and 19 separate deprecation notices. The full tree reports
21 advisories (one critical, two high, 14 moderate, four low) and 36 separate
deprecation notices. The critical/high entries are the three Babel/Browserslist
build advisories described below; the browser and optional runtime advisories
remain part of the totals.

The editor defaults to filesystem uploads. GitHub sign-in is enabled only when
configured. The AWS, Azure, MinIO and Mattermost integrations below are optional:
upload adapters load only for the selected `CMD_IMAGE_UPLOAD_TYPE`, and the
Mattermost login route loads only when its client credentials are configured.
The reviewed entry points are the editor's `lib/web/imageRouter/` adapters and
`lib/web/auth/mattermost/index.js`, with activation in `lib/config/`.

## optional integrations

| Integration | Remaining advisory | Reachability and disposition |
| --- | --- | --- |
| AWS SDK v2, `aws-sdk` 2.1693.0 | [GHSA-j965-2qgj-vjmq](https://github.com/advisories/GHSA-j965-2qgj-vjmq) | The S3 adapter calls `putObject` with an operator-configured region, endpoint and bucket. A note or upload cannot choose those values. A malicious region can redirect signed API requests; protect deployment configuration and use an exact trusted region. Replace this unsupported SDK with an AWS SDK v3 adapter. |
| Azure Storage, `azure-storage` 2.10.7 → `request` 2.88.2 | [GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6) | The Azure adapter creates a container and uploads to an operator-configured connection string. Provider responses reach Request's redirect handling, so a compromised or misconfigured endpoint remains a risk. Request has no patched release. Keep this adapter disabled pending migration to the maintained Azure SDK. Updating its XML/cookie dependencies does not fix this advisory. |
| Mattermost 3.4.0 → `superagent` 1.8.3 | [GHSA-8225-6cvr-8pqp](https://github.com/advisories/GHSA-8225-6cvr-8pqp) | Login calls `getMe` on the configured Mattermost server. Its compressed response can consume unbounded resources in the old HTTP client. Ordinary notes cannot select that endpoint, but the provider-response path is reachable when enabled. Leave Mattermost credentials unset pending replacement of the legacy adapter and bounded response handling. |
| MinIO 8.0.7 → `decode-uri-component` 0.2.2 | [GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) | SpecDoc calls `putObject` with a generated object name. Reviewed MinIO calls use `query-string.stringify`, not the vulnerable decoder. The vulnerable dependency remains installed; updating it requires compatibility work with the old CommonJS query-string dependency. Reassess before adding APIs that parse caller-supplied URLs or queries. |
| MinIO 8.0.7 → `stream-json` 1.9.1 | [filter complexity](https://github.com/advisories/GHSA-528h-pc64-c93x), [JSONC comment complexity](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [Assembler prototype pollution](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | MinIO imports the JSONL parser for its notification listener. SpecDoc does not call that listener, filters, JSONC parsing or Assembler; its upload path uses `putObject`. These packages still require an SDK-compatible upgrade. Do not force a new major parser version without exercising the adapter. |

Uploads use generated filenames, raster format checks, size and concurrency
limits. These controls do not repair vulnerable SDK response processing. Keep
optional providers disabled unless needed; restrict configured endpoints to
trusted HTTPS services and constrain outbound access. Only deployment operators
should control regions, endpoints, connection strings and buckets. Container
memory/CPU limits reduce the impact of resource exhaustion but do not resolve
the advisories.

The transitive `uuid` 3.4.0/8.x copies in AWS, Azure and Sequelize also retain
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
The affected APIs are v3/v5/v6 with a caller-provided output buffer. The reviewed
callers use v1/v4 for generated IDs; no route to an affected call was found.
Sequelize is part of the normal editor runtime, so this is not solely an
optional-provider dependency. The editor's direct UUID dependency is patched;
the transitive copies still need dependency upgrades.

## browser dependencies

Bootstrap 3.4.1 remains affected by
[button attribute XSS](https://github.com/advisories/GHSA-vxmc-5x29-h64v) and
[tooltip/popover XSS](https://github.com/advisories/GHSA-q58r-hwc8-rm9j).
SpecDoc now strips plugin activation and HTML/template configuration attributes
from note HTML and Reveal comment attributes using the same policy. Profile
attributes are escaped, and the older vendored slide tooltip was removed.
These are application boundary controls; the Bootstrap package advisory remains
open until the UI dependency is replaced. Preserve these controls in custom
themes and rendering extensions.

Reveal 3.9.2 retains
[GHSA-hhqj-cfjx-vj25](https://github.com/advisories/GHSA-hhqj-cfjx-vj25), concerning
untrusted messages to its speaker view. SpecDoc removes the speaker plugin
loader, excludes both speaker plugin directories from built assets, and removes
their inline-script CSP exception. Deploy a clean asset build so old speaker
pages are not left behind. The dependency still requires a maintained release
before that feature can be restored.

## build and test dependencies

The legacy build chain also needs replacement. Its inputs are checkout source,
assets and build configuration; the running service does not send note content
through Webpack or Babel. Build reviewed source in a disposable environment
without production credentials. Do not run builds of untrusted forks in a
privileged release job.

| Dependency | Remaining advisory and boundary |
| --- | --- |
| Babel 6 `babel-traverse` | [GHSA-67hx-6x53-jw92](https://github.com/advisories/GHSA-67hx-6x53-jw92) is a critical arbitrary-code-execution advisory for compiling malicious source with affected plugins. Babel 6 has no planned fix; migrate the compiler and plugins together. |
| Browserslist 3 through `babel-preset-env` | [query cache exhaustion](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and [custom stats processing](https://github.com/advisories/GHSA-73wf-gq98-2v4g) affect build queries/configuration. Retire the old preset with the Babel migration. |
| CSS parsing and file matching | [Colord](https://github.com/advisories/GHSA-2wm5-q62r-hmrv), [PostCSS selector parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf), and [Micromatch](https://github.com/advisories/GHSA-952p-6rrq-rcjv) report resource exhaustion on malformed input. Their reviewed consumers are stylesheet optimization and build file selection. |
| Mocha's `diff` and the esbuild loader | [Diff patch processing](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) and [esbuild's Windows development server](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) remain tooling advisories. SpecDoc uses Mocha for tests and esbuild for asset compilation; it does not expose their patch APIs or development server to note authors. |
| Webpack 4 crypto polyfills | [Elliptic signatures](https://github.com/advisories/GHSA-848j-6mx2-7j84) and [PBKDF2 work amplification](https://github.com/advisories/GHSA-477h-4r7f-fvrx) remain in the installed polyfill dependency tree. No application consumer of their signing/password-derivation APIs was found. Do not add such a consumer without replacing the affected implementations. |

## reading audit output

Audit the editor after applying the fork patches and installing the locked
dependencies. Run both the production dependency audit and the full dependency
audit: some browser libraries are declared as development dependencies but are
shipped in the compiled application. A production-only audit cannot establish
browser safety.

From the prepared editor checkout:

```sh
yarn npm audit --all --recursive --environment production --json
yarn npm audit --all --recursive --json
```

CI runs `hack/check-editor-audit.cjs` against the full tree and fails on new high
or critical advisories. The only exceptions are the three documented Babel and
Browserslist package/advisory pairs, further limited to their reviewed versions
and dependency parents. Registry errors, malformed output and subprocess
failures fail the job. Exceptions remain visible in the output; this gate does
not treat moderate/low findings as resolved or replace the browser regressions.

Yarn also reports deprecated packages in its audit JSON. Entries whose ID ends
in `(deprecation)` are maintenance warnings, not GHSA vulnerability reports.
Track them separately; neither the total number of JSON lines nor the highest
severity alone describes request exposure. Recheck this disposition whenever
dependencies, optional adapters or browser features change.
