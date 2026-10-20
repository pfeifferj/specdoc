'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  loadCredential, saveCredential, preflightStorage, credentialPath, removeCredential
} = require('../lib/credentials')

function fixture (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { profile: 'test', profileData: {}, configDir: dir, editorOrigin: 'https://editor.test', boardOrigin: 'https://board.test', env: {} }
}

test('file credentials are private, atomic, and bound to profile, identity and origin', async t => {
  const config = fixture(t)
  await preflightStorage(config, 'author', 'file')
  await saveCredential(config, 'author', 'author-secret', { user: { id: 'user' } }, 'file')
  assert.equal(await loadCredential(config), 'author-secret')
  assert.equal(fs.statSync(credentialPath(config, 'author')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(credentialPath(config, 'author'))).mode & 0o777, 0o700)
  assert.equal(await loadCredential({ ...config, editorOrigin: 'https://other.test' }), null)
  assert.equal(await loadCredential({ ...config, profile: 'other' }), null)
  assert.equal(await loadCredential(config, 'bot'), null)
  await saveCredential(config, 'bot', 'bot-secret', {}, 'file')
  assert.equal(await loadCredential(config, 'bot'), 'bot-secret')
  await removeCredential(config, 'author')
  assert.equal(await loadCredential(config), null)
  assert.equal(await loadCredential(config, 'bot'), 'bot-secret')
})

test('environment credentials require their matching service URL', async t => {
  const config = fixture(t)
  config.env.SPECDOC_TOKEN = 'environment-secret'
  await assert.rejects(loadCredential(config), { code: 'CREDENTIAL_ORIGIN_MISMATCH' })
  config.env.SPECDOC_EDITOR_URL = 'https://wrong.test'
  await assert.rejects(loadCredential(config), { code: 'CREDENTIAL_ORIGIN_MISMATCH' })
  config.env.SPECDOC_EDITOR_URL = config.editorOrigin
  assert.equal(await loadCredential(config), 'environment-secret')
  config.authorToken = 'stdin-secret'
  assert.equal(await loadCredential(config), 'stdin-secret')
})

test('overly broad file permissions and symlinks cannot expose credentials', async t => {
  const config = fixture(t)
  await saveCredential(config, 'author', 'private-secret', {}, 'file')
  const file = credentialPath(config, 'author')
  fs.chmodSync(file, 0o644)
  await assert.rejects(loadCredential(config), { code: 'CREDENTIAL_PERMISSIONS' })
  fs.chmodSync(file, 0o600)
  fs.renameSync(file, file + '.original')
  fs.symlinkSync(file + '.original', file)
  await assert.rejects(loadCredential(config), { code: 'CREDENTIAL_PERMISSIONS' })
})

test('keyring explicitly requires persistent Secret Service and never falls back', async t => {
  const config = fixture(t)
  const passwords = new Map()
  config.keyringFactory = class {
    constructor (service, account, options) {
      assert.equal(service, 'specdoc')
      assert.deepEqual(options, { linux: { store: 'secret-service' } })
      this.account = account
    }
    async setPassword (password) { passwords.set(this.account, password) }
    async getPassword () { return passwords.get(this.account) || null }
    async deleteCredential () { return passwords.delete(this.account) }
  }
  await preflightStorage(config)
  assert.equal(passwords.size, 0)
  await saveCredential(config, 'author', 'keyring-secret', {})
  assert.equal(await loadCredential(config), 'keyring-secret')
  config.keyringFactory = class { constructor () { throw new Error('unavailable') } }
  await assert.rejects(loadCredential(config), { code: 'KEYRING_UNAVAILABLE' })
  assert.equal(fs.existsSync(path.join(config.configDir, 'credentials')), false)
})

test('a keyring write that commits then fails cannot overwrite the previous credential', async t => {
  const config = fixture(t)
  const passwords = new Map()
  let unavailable = false
  config.keyringFactory = class {
    constructor (service, account) { this.account = account }
    async setPassword (password) {
      passwords.set(this.account, password)
      if (unavailable) throw new Error('connection lost after commit')
    }
    async getPassword () {
      if (unavailable) throw new Error('keyring unavailable')
      return passwords.get(this.account) || null
    }
    async deleteCredential () {
      if (unavailable) throw new Error('keyring unavailable')
      return passwords.delete(this.account)
    }
  }
  await saveCredential(config, 'author', 'old-secret', {})
  const previousSlot = config.profileData.credentials.author.slot
  unavailable = true
  await assert.rejects(saveCredential(config, 'author', 'new-secret', {}), cause =>
    cause.code === 'KEYRING_UNAVAILABLE' && cause.details.stagedCredentialCleanup === 'unconfirmed')
  assert.equal(config.profileData.credentials.author.slot, previousSlot)
  unavailable = false
  assert.equal(await loadCredential(config), 'old-secret')
})
