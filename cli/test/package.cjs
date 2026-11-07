'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-package-'))
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))[0]
  const install = path.join(temp, 'install')
  fs.mkdirSync(install)
  execFileSync('npm', ['install', '--prefix', install, '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], { encoding: 'utf8' })
  const binary = path.join(install, 'node_modules/specdoc-cli/bin/specdoc.js')
  const empty = path.join(temp, 'empty'); fs.mkdirSync(empty)
  const env = { ...process.env, SPECDOC_CONFIG_DIR: path.join(temp, 'config'), SPECDOC_TEST_BINARY: binary }
  assert.match(execFileSync(process.execPath, [binary, '--help'], { cwd: empty, env, encoding: 'utf8' }), /note update/)
  assert.ok(!fs.existsSync(path.join(install, 'node_modules/tree-sitter')))
  assert.ok(!fs.existsSync(path.join(install, 'node_modules/@napi-rs/keyring')))
  const build = execFileSync(process.execPath, [binary, 'context', 'build', '--repo', path.dirname(root), '--max-tokens', '3000', '--format', 'json'], { cwd: empty, env: { ...env, SPECDOC_BOARD_URL: 'http://127.0.0.1:1' }, encoding: 'utf8' })
  assert.equal(JSON.parse(build).data.kind, 'specdoc-build-packet')
  assert.ok(JSON.parse(build).data.nodes.length > 0)
  assert.ok(Math.ceil(build.trimEnd().length / 4) <= 3000)
  const repository = path.dirname(root)
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const snapshot = { repository, revision, path: 'README.md' }
  const bundle = path.join(temp, 'change.json')
  fs.writeFileSync(bundle, JSON.stringify({ schemaVersion: 1, title: 'Unchanged source control', inventory: { reviewed: true, notes: 'No changed obligations in identical snapshots.' },
    sources: [{ id: 'guide', base: snapshot, candidate: snapshot }], obligations: [], provides: [], requires: [], relations: [] }))
  const preview = execFileSync(process.execPath, [binary, 'context', 'preview', '--config', bundle, '--require-valid', '--max-tokens', '32000', '--format', 'json'], {
    cwd: empty, env: { ...env, SPECDOC_BOARD_URL: 'http://127.0.0.1:1' }, encoding: 'utf8'
  })
  assert.equal(JSON.parse(preview).data.kind, 'specdoc-change-preview')
  assert.equal(JSON.parse(preview).data.structurallyValid, true)
  assert.equal(JSON.parse(preview).data.semanticPreservationVerified, false)
  execFileSync(process.execPath, ['--test', path.join(__dirname, 'cli.test.js')], { cwd: empty, env, stdio: 'inherit' })
  console.log('Packed CLI remote operations, build discovery and change preview work without optional native dependencies')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
