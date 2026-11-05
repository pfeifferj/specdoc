'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mergeManifest, dropLockCommits, checkManifest, checkForkPatches, checkLockCommit } = require('./rebase-manifest.cjs')

const base = {
  version: '1.11.0', engines: { node: '>=18' }, packageManager: 'yarn@4.12.0',
  dependencies: { a: '1.0.0', github: '1.1.0', removed: '1.0.0' },
  devDependencies: { lint: '1.0.0' }, scripts: { build: 'build-old', test: 'test' }
}
const target = {
  version: '1.12.0', engines: { node: '>=20.17' }, packageManager: 'yarn@4.13.0',
  dependencies: { a: '2.0.0', github: '1.1.0' },
  devDependencies: { lint: '2.0.0' }, scripts: { build: 'build-new', test: 'test' }
}

test('takes target metadata, toolchain and unchanged dependency updates', () => {
  const fork = structuredClone(base)
  fork.version = '1.10.7'
  const result = mergeManifest(base, fork, target)
  assert.equal(result.version, '1.12.0')
  assert.deepEqual(result.engines, target.engines)
  assert.equal(result.packageManager, 'yarn@4.13.0')
  assert.deepEqual(result.dependencies, target.dependencies)
  assert.deepEqual(result.devDependencies, target.devDependencies)
  assert.equal(result.scripts.build, 'build-new')
})

test('retains fork additions and independent script changes', () => {
  const fork = structuredClone(base)
  fork.dependencies.entities = '^7.0.1'
  fork.scripts.integration = 'run-integration'
  fork.scripts.test = 'test-with-fixtures'
  const result = mergeManifest(base, fork, target)
  assert.equal(result.dependencies.entities, '^7.0.1')
  assert.equal(result.scripts.integration, 'run-integration')
  assert.equal(result.scripts.test, 'test-with-fixtures')
})

test('preserves an independent runtime floor and requires review when both sides change it', () => {
  const fork = structuredClone(base)
  fork.engines = { node: '>=20.17' }
  const unchanged = structuredClone(target)
  unchanged.engines = base.engines
  assert.deepEqual(mergeManifest(base, fork, unchanged).engines, fork.engines)
  const changed = structuredClone(target)
  changed.engines = { node: '>=22' }
  assert.throws(() => mergeManifest(base, fork, changed), /runtime requirements changed/)
})

test('retains a fork patch when its upstream package version is unchanged', () => {
  const fork = structuredClone(base)
  fork.dependencies.github = 'patch:github@npm%3A1.1.0#~/.yarn/patches/github.patch'
  assert.equal(mergeManifest(base, fork, target).dependencies.github, fork.dependencies.github)
})

test('requires patch review after an upstream package bump', () => {
  const fork = structuredClone(base)
  fork.dependencies.github = 'patch:github@npm%3A1.1.0#~/.yarn/patches/github.patch'
  const bumped = structuredClone(target)
  bumped.dependencies.github = '1.2.0'
  assert.throws(() => mergeManifest(base, fork, bumped), /dependencies.github/)
})

test('rejects a manually supplied manifest that drops a matching fork patch', () => {
  const fork = structuredClone(base)
  fork.dependencies.github = 'patch:github@npm%3A1.1.0#~/.yarn/patches/github.patch'
  assert.throws(() => checkForkPatches(target, fork, target), /Required dependency patch missing: dependencies.github/)
  const resolved = structuredClone(target)
  resolved.dependencies.github = fork.dependencies.github
  assert.doesNotThrow(() => checkForkPatches(resolved, fork, target))
})

test('rejects removal of an upstream dependency patch from a manual manifest', () => {
  const patched = structuredClone(target)
  patched.dependencies.github = 'patch:github@npm%3A1.1.0#~/.yarn/patches/upstream.patch'
  assert.throws(() => checkForkPatches(target, base, patched), /Required dependency patch missing/)
})

test('rejects plain dependency overrides instead of hiding upstream updates', () => {
  const fork = structuredClone(base)
  fork.dependencies.a = '0.9.0'
  assert.throws(() => mergeManifest(base, fork, target), /dependencies.a/)
  const unchanged = structuredClone(base)
  assert.throws(() => mergeManifest(base, fork, unchanged), /dependencies.a/)
})

test('requires resolution for a script edited on both sides', () => {
  const fork = structuredClone(base)
  fork.scripts.build = 'fork-build'
  assert.throws(() => mergeManifest(base, fork, target), /scripts.build/)
})

test('rejects conflicting versions introduced across dependency sections', () => {
  const fork = structuredClone(base)
  fork.devDependencies.a = '0.5.0'
  assert.throws(() => mergeManifest(base, fork, target), /runtime and development/)
})

test('only accepts HedgeDoc 1.x and string-valued dependency declarations', () => {
  assert.throws(() => checkManifest({ version: '2.0.0' }), /1.x release/)
  assert.throws(() => checkManifest({ version: '1.10.7' }, '1.12.0'), /must match target/)
  assert.throws(() => checkManifest({ version: '1.12.0', dependencies: [] }), /Invalid manifest section/)
  assert.throws(() => checkManifest({ version: '1.12.0', dependencies: { a: null } }), /Invalid dependencies.a/)
})

test('drops buried lock commits without changing other replay commands', () => {
  const todo = 'pick aaaaaaa before\npick bbbbbbb lock\npick ccccccc after\n# comment\n'
  assert.equal(dropLockCommits(todo, ['b'.repeat(40)]), todo.replace('pick bbbbbbb', 'drop bbbbbbb'))
})

test('rejects a marked commit that changes application code', () => {
  assert.doesNotThrow(() => checkLockCommit('Specdoc-Lock: 1.11.0\n', ['package.json', 'yarn.lock']))
  assert.throws(() => checkLockCommit('Specdoc-Lock: 1.11.0\n', ['package.json', 'lib/realtime.js']), /only package.json and yarn.lock/)
  assert.throws(() => checkLockCommit('Specdoc-Lock: 1.11.0\n', []), /only package.json and yarn.lock/)
})

test('does not treat a body mention as a lock trailer', () => {
  const message = 'Change behavior\n\nSpecdoc-Lock: 1.11.0\n\nThis is ordinary body text.\n'
  const trailers = execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' })
  assert.throws(() => checkLockCommit(trailers, ['package.json']), /one Specdoc-Lock release trailer/)
})

test('refuses a replay that does not account for every selected lock commit', () => {
  assert.throws(() => dropLockCommits('pick aaaaaaa other\n', ['b'.repeat(40)]), /missing from replay/)
  assert.throws(() => dropLockCommits('pick bbb lock\n', ['b'.repeat(40), 'bbb' + 'c'.repeat(37)]), /Ambiguous/)
})
