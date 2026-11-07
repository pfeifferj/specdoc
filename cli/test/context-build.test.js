'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Build } = require('../lib/context/build')
const { boundedBuildPacket, queryBuild } = require('../lib/context/build-context')
const { spawnSync } = require('node:child_process')

function fixture (t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-build-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  const write = (file, text, tracked = true) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), text)
    if (tracked) git('add', '--', file)
  }
  return { repo, git, write }
}

function packageManifest (name, extra = '') {
  return `[package]\nname = "${name}"\nversion = "1.0.0"\nedition = "2024"\n${extra}`
}

test('Cargo workspace and path/test relationships carry exact source bytes and scope', t => {
  const { repo, git, write } = fixture(t)
  write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/excluded"]\n[workspace.dependencies]\nclock = { path = "crates/clock" }\nserde = "1"\n')
  write('crates/engine/Cargo.toml', packageManifest('engine', '[dependencies]\nclock = { workspace = true }\nserde = { workspace = true }\n[dev-dependencies]\nhelper = { path = "../helper", optional = true }\n[target.\'cfg(unix)\'.build-dependencies]\nclock = { path = "../clock" }\n[[test]]\nname = "acceptance"\npath = "checks/acceptance.rs"\nrequired-features = ["vm"]\n'))
  write('crates/engine/checks/acceptance.rs', '#[test] fn acceptance() {}\n')
  write('crates/engine/tests/ordinary.rs', '#[test] fn ordinary() {}\n')
  for (const name of ['clock', 'helper', 'excluded']) write(`crates/${name}/Cargo.toml`, packageManifest(name))
  git('commit', '-qm', 'Declare fixture packages')
  const graph = new Build(repo).refresh().packet()
  const workspace = graph.nodes.find(n => n.kind === 'cargo-workspace')
  const members = graph.edges.filter(e => e.from === workspace.id && e.relation === 'declares_member')
  assert.deepEqual(members.map(e => graph.nodes.find(n => n.id === e.to).name).sort(), ['clock', 'engine', 'helper'])
  const engine = graph.nodes.find(n => n.kind === 'cargo-package' && n.name === 'engine')
  const dependencies = graph.edges.filter(e => e.from === engine.id && e.relation === 'declares_path_dependency')
  assert.equal(dependencies.length, 3)
  assert.equal(dependencies.find(e => e.workspaceInherited).evidence.length, 2)
  assert.equal(dependencies.find(e => e.name === 'helper').dependencyKind, 'dev-dependencies')
  assert.equal(dependencies.find(e => e.name === 'helper').optional, true)
  assert.equal(dependencies.find(e => e.condition).condition, 'cfg(unix)')
  const acceptance = graph.nodes.find(n => n.kind === 'cargo-test-target' && n.name === 'acceptance')
  assert.equal(acceptance.path, 'crates/engine/checks/acceptance.rs')
  assert.deepEqual(acceptance.requiredFeatures, ['vm'])
  assert.equal(acceptance.discovery, 'explicit')
  assert.equal(acceptance.available, true)
  assert.equal(graph.nodes.find(n => n.name === 'ordinary').discovery, 'conventional-layout')
  for (const evidence of [...graph.nodes.flatMap(n => n.evidence), ...graph.edges.flatMap(e => e.evidence)]) {
    assert.equal(evidence.revision, git('rev-parse', 'HEAD'))
    assert.equal(evidence.sha256, createHash('sha256').update(fs.readFileSync(path.join(repo, evidence.path))).digest('hex'))
    assert.ok(evidence.line > 0 && evidence.endLine >= evidence.line)
    assert.equal(evidence.basis, 'tracked-working-tree')
  }
  assert.deepEqual(graph.gaps, [])
  assert.equal(graph.trackedOnly, true)
  assert.equal(graph.dirty, false)
})

test('discovery never runs scripts or Make and reads tags only in the first ten lines', t => {
  const { repo, write } = fixture(t)
  write('package.json', JSON.stringify({ name: 'example', scripts: { test: 'touch SHOULD_NOT_EXIST', 'pretest': 'touch SHOULD_NOT_EXIST_EITHER' } }, null, 2))
  write('Makefile', 'include optional.mk\n.PHONY: test\ntest check: build $(INPUT)\n\ttouch SHOULD_NOT_EXIST\n\ndefine DYNAMIC\nnot-a-target: fake\nendef\n%.out: %.in\n\n$(DYNAMIC): fake\n')
  write('tests/meta.sh', '#!/bin/sh\n# tags: build,meta\ntouch SHOULD_NOT_EXIST\n')
  write('tests/late.sh', `${'\n'.repeat(10)}# tags: unsafe\n`)
  const graph = new Build(repo).refresh().packet()
  assert.equal(fs.existsSync(path.join(repo, 'SHOULD_NOT_EXIST')), false)
  assert.deepEqual(graph.nodes.filter(n => n.kind === 'npm-script').map(n => n.command), ['touch SHOULD_NOT_EXIST', 'touch SHOULD_NOT_EXIST_EITHER'])
  assert.deepEqual(graph.nodes.filter(n => n.kind === 'make-target').map(n => n.name), ['test', 'check'])
  assert.equal(graph.nodes.find(n => n.kind === 'make-target').evidence[0].line, 3)
  assert.ok(graph.nodes.some(n => n.kind === 'make-pattern-target' && n.name === '%.out'))
  assert.deepEqual(graph.nodes.find(n => n.path === 'tests/meta.sh').tags, ['build', 'meta'])
  assert.deepEqual(graph.nodes.find(n => n.path === 'tests/late.sh').tags, [])
  assert.equal(graph.nodes.find(n => n.path === 'tests/meta.sh').evidence[0].line, 2)
  assert.ok(graph.gaps.some(g => g.code === 'unevaluated-make'))
  assert.ok(graph.limits.some(l => l.includes('no command is executed')))
})

test('malformed, unresolved and untracked build inputs do not become established facts', t => {
  const { repo, write } = fixture(t)
  write('Cargo.toml', '[workspace]\nmembers = ["crates/*", "missing", "other/**"]\n')
  write('crates/engine/Cargo.toml', packageManifest('engine', '[dependencies]\noutside = { path = "../../../outside" }\nabsolute = { path = "/outside" }\n[[test]]\nname = "missing"\npath = "tests/untracked.rs"\nrequired-features = [9223372036854775808]\n'))
  write('crates/engine/tests/untracked.rs', '#[test] fn hidden() {}\n', false)
  write('untracked/Cargo.toml', packageManifest('hidden'), false)
  write('bad/Cargo.toml', '[package\nname = "bad"\n')
  write('bad/package.json', '{"scripts": invalid}')
  const graph = new Build(repo).refresh().packet()
  assert.equal(graph.nodes.some(n => n.name === 'hidden' || n.name === 'bad'), false)
  assert.equal(graph.nodes.find(n => n.name === 'missing').available, false)
  assert.ok(graph.gaps.some(g => g.code === 'unresolved-path-dependency' && g.message.includes('../outside/Cargo.toml')))
  assert.ok(graph.nodes.some(n => n.kind === 'cargo-unresolved-path' && n.manifest === '/outside/Cargo.toml'))
  assert.ok(graph.gaps.some(g => g.code === 'unresolved-test-source'))
  assert.ok(graph.gaps.some(g => g.code === 'unresolved-member'))
  assert.ok(graph.gaps.some(g => g.code === 'unsupported-member-pattern'))
  assert.ok(graph.gaps.some(g => g.code === 'invalid-test-features'))
  assert.doesNotThrow(() => boundedBuildPacket(graph, { max_tokens: 3000 }))
  assert.equal(graph.gaps.filter(g => g.code === 'invalid-manifest').length, 2)
})

test('working-tree edits refresh evidence and symlink sources stay outside the graph', t => {
  const { repo, git, write } = fixture(t)
  write('Cargo.toml', packageManifest('before', 'autotests = false\n'))
  write('tests/not-auto.rs', '#[test] fn ordinary() {}\n')
  git('commit', '-qm', 'Declare fixture')
  const build = new Build(repo).refresh()
  const oldHash = build.packet().nodes[0].evidence[0].sha256
  write('Cargo.toml', packageManifest('after', 'autotests = false\n'), false)
  assert.equal(build.refresh().packet().nodes.find(n => n.kind === 'cargo-package').name, 'after')
  assert.notEqual(build.packet().nodes[0].evidence[0].sha256, oldHash)
  assert.equal(build.packet().dirty, true)
  assert.equal(build.packet().nodes.some(n => n.kind === 'cargo-test-target'), false)
  fs.symlinkSync(path.join(repo, 'Cargo.toml'), path.join(repo, 'linked-Cargo.toml'))
  fs.mkdirSync(path.join(repo, 'unsafe'))
  fs.symlinkSync(path.join(repo, 'Cargo.toml'), path.join(repo, 'unsafe/Cargo.toml'))
  git('add', '--', 'unsafe/Cargo.toml')
  assert.equal(build.refresh().packet().nodes.some(n => n.manifest === 'unsafe/Cargo.toml'), false)
  assert.ok(build.packet().gaps.some(g => g.code === 'unsafe-source'))
  const node = build.packet().nodes.find(n => n.kind === 'cargo-package')
  assert.equal(build.neighbors(node.id).node.id, node.id)
  assert.equal(build.neighbors('unknown'), null)
})

test('real TOML and inherited editions preserve Cargo test discovery rules', t => {
  const { repo, write } = fixture(t)
  write('Cargo.toml', '[workspace]\nmembers = ["modern", "legacy"]\n[workspace.package]\nedition = "2024"\n')
  write('modern/Cargo.toml', `[package]\nname = "modern"\nversion = "1.0.0"\nedition.workspace = true\ndescription = '''\n[workspace]\nThis text is not a workspace declaration.\n'''\n[[test]]\nname = "declared"\npath = "tests/declared.rs"\n`)
  write('legacy/Cargo.toml', '[package]\nname = "legacy"\nversion = "1.0.0"\n[[test]]\nname = "declared"\npath = "tests/declared.rs"\n')
  for (const directory of ['modern', 'legacy']) {
    write(`${directory}/tests/declared.rs`, '#[test] fn declared() {}\n')
    write(`${directory}/tests/automatic.rs`, '#[test] fn automatic() {}\n')
  }
  const graph = new Build(repo).refresh().packet()
  assert.equal(graph.nodes.filter(n => n.kind === 'cargo-workspace').length, 1)
  assert.ok(graph.nodes.some(n => n.kind === 'cargo-test-target' && n.path === 'modern/tests/automatic.rs'))
  assert.equal(graph.nodes.some(n => n.kind === 'cargo-test-target' && n.path === 'legacy/tests/automatic.rs'), false)
  assert.ok(graph.nodes.find(n => n.path === 'modern/tests/automatic.rs').evidence.some(e => e.path === 'Cargo.toml'))
})

test('CI jobs and steps preserve literal scopes, dependencies and expressions without execution', t => {
  const { repo, git, write } = fixture(t)
  const file = '.github/workflows/check.yml'
  const yaml = `name: checks
on: [push, pull_request]
env:
  OWNER: workflow
defaults:
  run:
    working-directory: project
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      OWNER: job
    defaults:
      run:
        shell: bash
    strategy:
      matrix:
        arch: [x86_64, aarch64]
    steps:
      - uses: actions/checkout@v4
      - id: verify
        run: |
          echo 'literal: # comment'
          touch SHOULD_NOT_EXIST
        working-directory: tests
        env:
          TOKEN: \${{ secrets.TEST_TOKEN }}
  review:
    needs: [build, absent]
    if: \${{ always() }}
    uses: ./\.github/workflows/reusable.yml
`
  write(file, yaml)
  git('commit', '-qm', 'Declare CI fixtures')
  const graph = new Build(repo).refresh().packet()
  const workflow = graph.nodes.find(n => n.kind === 'ci-workflow')
  const build = graph.nodes.find(n => n.kind === 'ci-job' && n.key === 'build')
  const step = graph.nodes.find(n => n.kind === 'ci-step' && n.stepId === 'verify')
  const review = graph.nodes.find(n => n.kind === 'ci-job' && n.key === 'review')
  assert.deepEqual(workflow.env, { OWNER: 'workflow' })
  assert.deepEqual(build.env, { OWNER: 'job' })
  assert.equal(workflow.defaultRun.workingDirectory, 'project')
  assert.equal(build.defaultRun.shell, 'bash')
  assert.equal(build.defaultRun.workingDirectory, undefined)
  assert.equal(step.workingDirectory, 'tests')
  assert.equal(step.env.TOKEN, '${{ secrets.TEST_TOKEN }}')
  assert.equal(step.run, "echo 'literal: # comment'\ntouch SHOULD_NOT_EXIST\n")
  assert.equal(review.uses, './.github/workflows/reusable.yml')
  assert.ok(graph.edges.some(e => e.from === review.id && e.to === build.id && e.relation === 'declares_needs' && e.conditional))
  assert.ok(graph.gaps.some(g => g.code === 'unevaluated-ci-matrix'))
  assert.ok(graph.gaps.some(g => g.code === 'unevaluated-ci-expression'))
  assert.ok(graph.gaps.some(g => g.code === 'unresolved-ci-needs'))
  assert.equal(fs.existsSync(path.join(repo, 'SHOULD_NOT_EXIST')), false)
  for (const fact of [...graph.nodes, ...graph.edges]) {
    assert.equal(fact.evidence[0].path, file)
    assert.equal(fact.evidence[0].sha256, createHash('sha256').update(yaml).digest('hex'))
    assert.equal(fact.evidence[0].line, 1)
  }
})

test('invalid YAML, executable tags and cyclic values never turn into invented CI facts', t => {
  const { repo, write } = fixture(t)
  write('.github/workflows/duplicate.yml', 'jobs:\n  check: {}\n  check: {}\n')
  write('.github/workflows/custom.yml', 'jobs: !custom {}\n')
  write('.github/workflows/cyclic.yml', 'jobs:\n  check:\n    <<: &base\n      runs-on: ubuntu-latest\n    env: &cycle\n      SELF: *cycle\n    steps: []\n')
  const graph = new Build(repo).refresh().packet()
  assert.equal(graph.gaps.filter(g => g.code === 'invalid-workflow').length, 2)
  assert.ok(graph.gaps.some(g => g.code === 'unsupported-workflow-value'))
  assert.ok(graph.gaps.some(g => g.code === 'unevaluated-ci-merge'))
  assert.equal(graph.nodes.find(n => n.kind === 'ci-job').runsOn, undefined)
  assert.equal(graph.nodes.filter(n => n.kind === 'ci-workflow').length, 1)
  assert.doesNotThrow(() => JSON.stringify(graph))
})

test('bounded build packets retain only whole facts and evidence with no dangling relationships', t => {
  const { repo, write } = fixture(t)
  const scripts = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`check-${n}`, `printf 'check ${n}'`]))
  scripts.huge = 'printf ' + 'x'.repeat(18000)
  write('package.json', JSON.stringify({ name: 'checks', scripts }))
  const graph = new Build(repo).refresh().packet()
  const packet = boundedBuildPacket(graph, { max_tokens: 1800 })
  assert.ok(Math.ceil(JSON.stringify({ schemaVersion: 1, data: packet }).length / 4) <= 1800)
  assert.equal(packet.kind, 'specdoc-build-packet')
  assert.equal(packet.declarationOnly, true)
  assert.ok(packet.omissions.nodes > 0)
  assert.equal(packet.complete, false)
  assert.ok(packet.nodes.some(n => n.kind === 'npm-script'))
  assert.equal(packet.nodes.some(n => n.name === 'huge'), false)
  const ids = new Set(packet.nodes.map(n => n.id))
  for (const node of packet.nodes) assert.deepEqual(node, graph.nodes.find(n => n.id === node.id))
  for (const edge of packet.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to))
    assert.ok(graph.edges.some(original => JSON.stringify(original) === JSON.stringify(edge)))
  }
  const target = graph.nodes.find(n => n.name === 'check-1')
  const focused = queryBuild(repo, { id: target.id, max_tokens: 3000 })
  assert.equal(focused.selection.id, target.id)
  assert.ok(focused.nodes.some(n => n.id === target.id))
  assert.ok(focused.edges.every(e => e.from === target.id || e.to === target.id))
  assert.throws(() => queryBuild(repo, { id: 'not-a-build-id', max_tokens: 3000 }), e => e.code === 'NOT_FOUND')
  assert.throws(() => queryBuild(repo, { id: graph.nodes.find(n => n.name === 'huge').id, max_tokens: 1500 }), e => e.code === 'BUDGET_TOO_SMALL')
})

test('CLI build discovery returns bounded structured declarations offline from another directory', t => {
  const { repo, git, write } = fixture(t)
  write('package.json', JSON.stringify({ name: 'offline', scripts: { test: 'node checks.js' } }))
  git('commit', '-qm', 'Declare offline tooling')
  const binary = path.resolve(__dirname, '../bin/specdoc.js')
  const run = extra => spawnSync(process.execPath, [binary, 'context', 'build', ...extra, '--repo', repo, '--max-tokens', '3000', '--format', 'json'], {
    cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, SPECDOC_BOARD_URL: 'http://127.0.0.1:1', SPECDOC_CONFIG_DIR: path.join(repo, 'no-profile') }
  })
  const result = run([])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Math.ceil(result.stdout.trimEnd().length / 4) <= 3000)
  const packet = JSON.parse(result.stdout).data
  assert.equal(packet.repository, repo)
  assert.equal(packet.revision, git('rev-parse', 'HEAD'))
  assert.equal(packet.complete, true)
  const unknown = run(['build:missing'])
  assert.equal(unknown.status, 1)
  assert.equal(JSON.parse(unknown.stderr).error.code, 'NOT_FOUND')
})
