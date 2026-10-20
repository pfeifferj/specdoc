# SpecDoc CLI

Read specs, edit raw Markdown notes, contribute bot reviews, and retrieve code
context from a terminal or coding agent. Requires Node 20 or newer.

Build an installable package from the SpecDoc repository:

```sh
cd cli
npm ci
npm pack
npm install --global ./specdoc-cli-0.1.0.tgz
```

The editor's CLI server update must be deployed before browser login works;
installing this package does not update the server. Sign in by opening the
link printed in your terminal:

```sh
specdoc auth login \
  --editor-url https://md.example.com \
  --board-url https://specs.example.com
specdoc auth status --format json
specdoc spec list --limit 20 --format json
```

Login stores an expiring author token in the OS keyring. Linux uses Secret
Service. Choose `--storage file` explicitly when no keyring is available.
Installing with `--omit=optional` supports remote operations and file storage.

```sh
specdoc note checkout NOTE_ID --output spec.md
# Edit spec.md, keeping its .specdoc.json state file.
specdoc note diff --state spec.md.specdoc.json --body-file spec.md
specdoc note update --state spec.md.specdoc.json --body-file spec.md --format json
```

Updates preserve the original ETag. If the server reports a conflict,
reconcile the change before submitting a new operation. If a response is lost,
use the reported operation key to recover the result:

```sh
specdoc operation get OPERATION_KEY --identity author --format json
```

Commands and flags use exact spellings. JSON results go to stdout; structured
errors go to stderr. Exit codes are 0 (success), 2 (usage), 1 (failure), and
130 (interruption). Stdin is explicit with `--body-file -` or `--token-stdin`.
Help and command schemas work offline:

```sh
specdoc --help
specdoc schema note.update --format json
```

The repository's `docs/cli.md` covers configuration, bot identities, recovery,
and context commands. Server-side login and receipt support require the
corresponding editor and board updates.
