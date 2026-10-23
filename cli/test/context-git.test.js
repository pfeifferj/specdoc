'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Build } = require('../lib/context/build')
const { Context } = require('../lib/context/runtime')
const { createManifest, loadManifest } = require('../lib/context/manifest')
const { readGit } = require('../lib/context/git')

test('local Git reads disable object substitution and implicit fetching', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-git-objects-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const repo = path.join(directory, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'rules.md'), 'Original contract\n')
  git('add', '.')
  git('commit', '-qm', 'Original fixture')
  const original = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'rules.md'), 'Substituted contract\n')
  git('add', '.')
  git('commit', '-qm', 'Substitute fixture')
  git('replace', original, git('rev-parse', 'HEAD'))
  assert.equal(git('show', `${original}:rules.md`), 'Substituted contract')
  assert.equal(readGit(repo, ['cat-file', 'blob', `${original}:rules.md`]), 'Original contract\n')
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({lazy:process.env.GIT_NO_LAZY_FETCH,replace:process.env.GIT_NO_REPLACE_OBJECTS}))\n`, { mode: 0o700 })
  const previous = process.env.PATH
  try {
    process.env.PATH = bin + path.delimiter + previous
    assert.deepEqual(JSON.parse(readGit(repo, ['version'])), { lazy: '1', replace: '1' })
  } finally { process.env.PATH = previous }
})

test('configured checkouts resist ambient Git redirection and never invoke configured fsmonitor hooks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-git-scope-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const setup = name => {
    const repo = path.join(directory, name)
    fs.mkdirSync(repo)
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    git('init', '-q')
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, scripts: { test: 'node checks.js' } }))
    fs.writeFileSync(path.join(repo, 'lib.rs'), `pub struct ${name};\n`)
    fs.writeFileSync(path.join(repo, 'rules.md'), `# Rules\n\n- **FR-001**: Preserve ${name} behavior.\n`)
    git('add', '.')
    git('commit', '-qm', `Declare ${name} behavior\n\nSpec: rules`)
    const head = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'fsmonitor.sh'), '#!/bin/sh\n: > "$PWD/FS_MONITOR_RAN"\n', { mode: 0o700 })
    git('config', 'core.fsmonitor', './fsmonitor.sh')
    return { repo, head }
  }
  const selected = setup('Selected')
  const redirected = setup('Redirected')
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { GIT_DIR: path.join(redirected.repo, '.git'), GIT_WORK_TREE: redirected.repo, GIT_INDEX_FILE: path.join(redirected.repo, '.git/index'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: './fsmonitor.sh' })
  try {
    const graph = new Build(selected.repo).refresh().packet()
    assert.equal(graph.revision, selected.head)
    assert.equal(graph.nodes.find(n => n.kind === 'npm-package').name, 'Selected')
    const manifest = createManifest({ schemaVersion: 1, implementation: { repository: selected.repo, revision: 'HEAD', scope: ['lib.rs'] },
      selection: { requirementsComplete: true, dependenciesComplete: true }, sources: [{ id: 'rules', namespace: 'example/specs', repository: selected.repo,
        revision: 'HEAD', path: 'rules.md', role: 'governing', authority: 'caller-selected-merged', requirements: [], dependencies: [] }] })
    assert.equal(manifest.implementation.revision, selected.head)
    assert.equal(manifest.sources[0].revision, selected.head)
    const file = path.join(directory, 'task.json')
    fs.writeFileSync(file, JSON.stringify(manifest))
    assert.equal(loadManifest(file).id, manifest.id)
    const ctx = await new Context(selected.repo, 'http://127.0.0.1:1', [], { manifest: file }).refresh()
    assert.ok(ctx.index.resolve('lib.rs#Selected'))
    assert.equal(ctx.index.resolve('lib.rs#Redirected'), null)
    assert.equal(ctx.repositoryState.head, selected.head)
    assert.ok(ctx.log.commits.some(c => c.subject === 'Declare Selected behavior'))
    assert.equal(ctx.log.commits.some(c => c.subject === 'Declare Redirected behavior'), false)
    const packet = await ctx.contextPacket({ task: 'behavior', require_complete: true, max_tokens: 3000 })
    assert.match(packet.text, /Preserve Selected behavior/)
    assert.doesNotMatch(packet.text, /Preserve Redirected behavior/)
    assert.equal(fs.existsSync(path.join(selected.repo, 'FS_MONITOR_RAN')), false)
    assert.equal(fs.existsSync(path.join(redirected.repo, 'FS_MONITOR_RAN')), false)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
