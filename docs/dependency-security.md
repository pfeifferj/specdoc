# dependency advisories

CI fails the board, CLI and MCP server on any high or critical advisory in
their production dependencies. The editor inherits a dependency tree with open
advisories; this page lists them with the code paths reviewed, operator
controls and remaining replacement work. Leaving a package unloaded or adding a
deployment control reduces exposure, but the advisory stays open until the
dependency is upgraded or replaced.

## optional integrations

The editor stores uploads on the filesystem by default. The AWS, Azure, MinIO
and Mattermost integrations are optional: an upload adapter loads only when
`CMD_IMAGE_UPLOAD_TYPE` selects it, and the Mattermost login route loads only
when its client credentials are configured. The reviewed entry points are the
editor's `lib/web/imageRouter/` adapters and `lib/web/auth/mattermost/index.js`,
with activation in `lib/config/`.

| integration | advisory | reachability |
| --- | --- | --- |
| AWS SDK v2, `aws-sdk` 2.1693.0 | [GHSA-j965-2qgj-vjmq](https://github.com/advisories/GHSA-j965-2qgj-vjmq): a malicious region can redirect signed API requests | The S3 adapter calls `putObject` with an operator-configured region, endpoint and bucket. A note or upload cannot choose those values. |
| Azure Storage, `azure-storage` 2.10.7 via `request` 2.88.2 | [GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6): SSRF through a redirect between HTTP and HTTPS. Request has no patched release | The adapter creates a container and uploads to an operator-configured connection string. Provider responses reach Request's redirect handling, so a compromised or misconfigured endpoint can redirect the editor's requests. |
| Mattermost 3.4.0 via `superagent` 1.8.3 | [GHSA-8225-6cvr-8pqp](https://github.com/advisories/GHSA-8225-6cvr-8pqp): a compressed response can consume unbounded resources | Login calls `getMe` on the configured Mattermost server. Notes cannot select that endpoint, but the response path is reachable when the integration is enabled. |
| MinIO 8.0.7 via `stream-json` 1.9.1 | [filter complexity](https://github.com/advisories/GHSA-528h-pc64-c93x), [JSONC comment complexity](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [Assembler prototype pollution](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | MinIO imports the JSONL parser for its notification listener. SpecDoc calls neither that listener nor filters, JSONC parsing or Assembler; uploads use `putObject`. |

Enable only the providers you need. With S3, protect the deployment
configuration and set an exact trusted region. Keep the Azure adapter disabled
and leave Mattermost credentials unset. Restrict configured endpoints to
trusted HTTPS services, constrain outbound access, and keep regions, endpoints,
connection strings and buckets under operator control. Container memory and
CPU limits reduce the impact of resource exhaustion.

The `uuid` 3.4.0 and 8.x copies under AWS, Azure and Sequelize carry
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), which
affects v3, v5 and v6 when the caller passes an output buffer. The reviewed
callers use v1 and v4 for generated IDs, and no route to an affected call was
found. Sequelize is part of the normal editor runtime, so this is not only an
optional-provider dependency. The editor's direct `uuid` dependency is patched.

## browser dependencies

Bootstrap 3.4.1 is affected by
[button attribute XSS](https://github.com/advisories/GHSA-vxmc-5x29-h64v) and
[tooltip/popover XSS](https://github.com/advisories/GHSA-q58r-hwc8-rm9j). One
sanitizer policy strips Bootstrap plugin activation and HTML/template
configuration attributes from note HTML and from Reveal element comments.
Profile attributes are escaped, and slides use the packaged Bootstrap tooltip
instead of an older vendored copy. Custom themes and rendering extensions must
keep these controls.

Reveal 3.9.2 has
[GHSA-hhqj-cfjx-vj25](https://github.com/advisories/GHSA-hhqj-cfjx-vj25), an
XSS through its speaker view, which accepts messages from any origin. The
editor ships no speaker plugin loader, leaves both speaker plugin directories
out of built assets and has no inline-script CSP exception for them. Deploy a
clean asset build so no old speaker pages remain.

## build and test dependencies

The build reads checkout source, assets and build configuration; the running
service never passes note content through Webpack or Babel. Build reviewed
source in a disposable environment without production credentials, and never
build untrusted forks in a privileged release job.

| dependency | advisory and boundary |
| --- | --- |
| Babel 6 `babel-traverse` | [GHSA-67hx-6x53-jw92](https://github.com/advisories/GHSA-67hx-6x53-jw92) is a critical arbitrary-code-execution advisory for compiling malicious source with affected plugins. |
| Browserslist 3 via `babel-preset-env` | [query cache exhaustion](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and [custom stats processing](https://github.com/advisories/GHSA-73wf-gq98-2v4g) affect build queries and configuration. |
| CSS parsing and file matching | [Colord](https://github.com/advisories/GHSA-2wm5-q62r-hmrv), [PostCSS selector parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) and [Micromatch](https://github.com/advisories/GHSA-952p-6rrq-rcjv) report resource exhaustion on malformed input. Their reviewed consumers are stylesheet optimization and build file selection. |
| Mocha's `diff` and the esbuild loader | [Diff patch processing](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) and [esbuild's Windows development server](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) affect tooling only. SpecDoc uses Mocha for tests and esbuild for asset compilation, and exposes neither their patch APIs nor the development server to note authors. |
| Webpack 4 crypto polyfills | [Elliptic signatures](https://github.com/advisories/GHSA-848j-6mx2-7j84) and [PBKDF2 work amplification](https://github.com/advisories/GHSA-477h-4r7f-fvrx) are in the installed polyfill tree. No application consumer of their signing or password-derivation APIs was found. |

## reading audit output

Audit the editor after applying the fork patches and installing the locked
dependencies. Run both audits from the prepared editor checkout: some browser
libraries are development dependencies that ship in the compiled application,
so the production audit alone misses them.

```sh
yarn npm audit --all --recursive --environment production --json
yarn npm audit --all --recursive --json
```

CI runs `hack/check-editor-audit.cjs` on the full tree and prints the current
advisory and deprecation counts. It fails on any high or critical advisory
other than the three Babel and Browserslist package and advisory pairs under
[build and test dependencies](#build-and-test-dependencies), and on registry
errors, malformed output or subprocess failures. Each exception is pinned to
its reviewed versions and to the dependents Yarn reports, but Yarn lists only
the first parent it visits for each package version, so another package
depending on the same version passes unchecked. The job prints the exceptions
it applied. Moderate and low advisories do not fail it, and it does not replace
the browser regression tests.

Yarn's audit JSON also lists deprecated packages. Entries whose ID ends in
`(deprecation)` are maintenance warnings, not GHSA advisories; the gate counts
them separately. Neither the number of JSON lines nor the highest severity
measures request exposure.

## remaining work

- Replace the AWS SDK v2 adapter with one on AWS SDK v3.
- Move the Azure adapter to the maintained Azure SDK.
- Replace the legacy Mattermost adapter and bound its response handling.
- Upgrade MinIO's `decode-uri-component` and `stream-json` in a way the SDK
  supports. The decoder needs compatibility work with the old CommonJS
  `query-string`; exercise the adapter before forcing a new major `stream-json`.
  Reassess the decoder before adding code that parses caller-supplied URLs or
  queries.
- Upgrade the transitive `uuid` copies.
- Replace Bootstrap 3.
- Move Reveal to a maintained release before restoring the speaker view.
- Replace the legacy build chain. Babel 6 has no planned fix: migrate the
  compiler and plugins together, and retire `babel-preset-env` and its
  Browserslist 3 with it.
- Replace the Webpack 4 polyfills' elliptic and PBKDF2 implementations before
  adding any consumer of their signing or password-derivation APIs.
- Review this page whenever dependencies, optional adapters or browser features
  change.
