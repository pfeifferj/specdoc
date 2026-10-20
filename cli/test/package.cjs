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
  execFileSync(process.execPath, ['--test', path.join(__dirname, 'cli.test.js')], { cwd: empty, env, stdio: 'inherit' })
  console.log('Packed CLI works from an empty directory without optional native dependencies')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
