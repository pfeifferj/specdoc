'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { runAuth } = require('../lib/auth')
const { resolveConfig, readConfig } = require('../lib/config')
const { loadCredential, loadStoredCredential, saveCredential } = require('../lib/credentials')

const TOKEN = 'specdoc_' + 'a'.repeat(64)
const OLD_TOKEN = 'specdoc_' + 'b'.repeat(64)
const identity = { user: { id: 'user-1', name: 'Test User' }, token: { id: 'token-1', scopes: ['notes:read', 'notes:write'], expiresAt: '2027-01-01T00:00:00.000Z' } }
const device = { device_code: 'd'.repeat(64), user_code: 'ABCD-EFGH', verification_uri: 'https://editor.test/cli/authorize', verification_uri_complete: 'https://editor.test/cli/authorize?user_code=ABCD-EFGH', expires_in: 600, interval: 5 }

function response (data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function fixture (t, dispatch, discovery = { protocolVersion: 1, role: 'editor', capabilities: { deviceAuthorization: true } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-auth-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { SPECDOC_CONFIG_DIR: dir }
  const config = resolveConfig({ editorUrl: 'https://editor.test', boardUrl: 'https://board.test' }, env)
  const calls = []
  const waits = []
  let output = ''
  let clock = 0
  return {
    config, env, calls, waits, signals: false,
    stderr: { write: text => { output += text } },
    stdout: { write: () => { throw new Error('auth handler must not print results itself') } },
    stdin: Readable.from([]),
    now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms },
    output: () => output,
    fetch: async (url, options) => {
      const request = { url, route: new URL(url).pathname, options, body: options.body && JSON.parse(options.body) }
      calls.push(request)
      if (request.route === '/.well-known/specdoc') return discovery instanceof Response ? discovery : response(discovery)
      return dispatch(request, calls)
    }
  }
}

test('legacy HTML 404 responses explain the missing server feature', async t => {
  const context = fixture(t, () => new Response('<html>404 Not Found</html>', {
    status: 404, headers: { 'content-type': 'text/html' }
  }))
  await assert.rejects(runAuth('login', { storage: 'file' }, context), cause =>
    cause.code === 'UNSUPPORTED_FEATURE' && cause.status === 404 && /deploy/i.test(cause.message))
})

test('discovery rejects an older editor before accessing storage or starting a grant', async t => {
  const context = fixture(t, () => { throw new Error('must not start a grant') },
    new Response('<html>404 Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }))
  context.config.keyringFactory = class { constructor () { throw new Error('must not access storage') } }
  await assert.rejects(runAuth('login', {}, context), cause =>
    cause.code === 'UNSUPPORTED_FEATURE' && /https:\/\/editor.test/.test(cause.message))
  assert.deepEqual(context.calls.map(call => call.route), ['/.well-known/specdoc'])
  assert.equal(context.calls[0].options.method, 'GET')
  assert.equal(context.calls[0].options.headers.authorization, undefined)
  assert.equal(context.output(), '')
})

test('discovery requires an editor advertising the supported device protocol', async t => {
  for (const discovery of [
    { protocolVersion: 1, role: 'board', capabilities: { deviceAuthorization: true } },
    { protocolVersion: 1, role: 'editor', capabilities: { deviceAuthorization: false } },
    { protocolVersion: 2, role: 'editor', capabilities: { deviceAuthorization: true } }
  ]) {
    const context = fixture(t, () => { throw new Error('must not start a grant') }, discovery)
    await assert.rejects(runAuth('login', { storage: 'file' }, context), { code: 'UNSUPPORTED_FEATURE' })
    assert.equal(fs.existsSync(path.join(context.config.configDir, 'credentials')), false)
  }
})

test('HTML service failures retain their HTTP status instead of implying missing support', async t => {
  const context = fixture(t, () => new Response(`<html>Proxy unavailable ${TOKEN}</html>`, {
    status: 503, headers: { 'content-type': 'text/html' }
  }))
  await saveCredential(context.config, 'author', TOKEN, identity, 'file')
  await assert.rejects(runAuth('status', {}, context), cause =>
    cause.code === 'AUTH_FAILED' && cause.status === 503 &&
    cause.message.includes('503') && !cause.message.includes(TOKEN))
})

test('browser approval stores token automatically; polling respects pending and slowdown', async t => {
  let polls = 0
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') {
      assert.equal(request.body.scope, 'notes:read notes:write')
      assert.equal(request.body.expires_in_days, 30)
      return response(device)
    }
    if (request.route === '/oauth/token') {
      assert.equal(request.options.redirect, 'error')
      if (++polls === 1) return response({ error: 'authorization_pending' }, 400)
      if (polls === 2) return response({ error: 'slow_down' }, 400)
      return response({ access_token: TOKEN, ...identity })
    }
    throw new Error('unexpected request')
  })
  const result = await runAuth('login', { storage: 'file' }, context)
  assert.equal(result.state, 'authenticated')
  assert.equal(result.verified, true)
  assert.deepEqual(context.waits, [5000, 5000, 10000])
  assert.match(context.output(), /ABCD-EFGH/)
  assert.match(context.output(), /https:\/\/editor.test\/cli\/authorize/)
  assert.ok(!context.output().includes(TOKEN))
  assert.ok(!JSON.stringify(result).includes(TOKEN))
  const reloaded = resolveConfig({}, context.env)
  assert.equal(await loadCredential(reloaded), TOKEN)
  assert.equal(readConfig(context.env).profiles.default.credentials.author.storage, 'file')
  assert.equal(context.calls.some(call => call.route.endsWith('/cancel')), false)
})

test('denial cancels the grant and preserves the previous credential', async t => {
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') return response(device)
    if (request.route === '/oauth/token') return response({ error: 'access_denied' }, 400)
    if (request.route === '/oauth/device/cancel') return response({ cancelled: true, revoked: false })
    throw new Error('unexpected request')
  })
  await saveCredential(context.config, 'author', OLD_TOKEN, identity, 'file')
  await assert.rejects(runAuth('login', { storage: 'file' }, context), cause => cause.code === 'access_denied' && cause.details.cleanup === 'confirmed')
  assert.equal(await loadCredential(context.config), OLD_TOKEN)
  assert.equal(context.calls.filter(call => call.route === '/oauth/device/cancel').length, 1)
})

test('lost exchange response is cancelled without blindly repeating token issuance', async t => {
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') return response(device)
    if (request.route === '/oauth/token') throw new Error('network dropped after token commit')
    if (request.route === '/oauth/device/cancel') return response({ cancelled: true, revoked: true })
    throw new Error('unexpected request')
  })
  await assert.rejects(runAuth('login', { storage: 'file' }, context), { code: 'AUTH_NETWORK' })
  assert.equal(context.calls.filter(call => call.route === '/oauth/token').length, 1)
  assert.equal(await loadCredential(context.config), null)
  assert.ok(!context.output().includes(device.device_code))
})

test('failed profile persistence restores the old token and revokes the issued token', async t => {
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') return response(device)
    if (request.route === '/oauth/token') {
      fs.mkdirSync(path.join(context.config.configDir, 'config.json'))
      return response({ access_token: TOKEN, ...identity })
    }
    if (request.route === '/oauth/device/cancel') return response({ cancelled: true, revoked: true })
    throw new Error('unexpected request')
  })
  await saveCredential(context.config, 'author', OLD_TOKEN, identity, 'file')
  await assert.rejects(runAuth('login', { storage: 'file' }, context))
  assert.equal(await loadCredential(context.config), OLD_TOKEN)
  assert.equal(context.calls.at(-1).route, '/oauth/device/cancel')
})

test('verification redirects to another service are rejected before browser opening', async t => {
  const context = fixture(t, request => request.route.endsWith('/cancel')
    ? response({ cancelled: true })
    : response({ ...device, verification_uri_complete: 'https://untrusted.test/approve' }))
  context.openBrowser = () => { throw new Error('must not open untrusted browser link') }
  await assert.rejects(runAuth('login', { storage: 'file', openBrowser: true }, context), { code: 'INVALID_RESPONSE' })
  assert.equal(context.calls.some(call => call.route === '/oauth/token'), false)
})

test('interrupt cancellation does not overwrite stored credentials', async t => {
  const aborter = new AbortController()
  const context = fixture(t, request => request.route.endsWith('/cancel')
    ? response({ cancelled: true, revoked: false })
    : response(device))
  context.signal = aborter.signal
  context.sleep = async () => { aborter.abort() }
  await assert.rejects(runAuth('login', { storage: 'file' }, context), cause => cause.code === 'INTERRUPTED' && cause.exitCode === 130)
  assert.equal(context.calls.at(-1).route, '/oauth/device/cancel')
})

test('status verifies remotely and only returns allowlisted metadata', async t => {
  const context = fixture(t, () => response({ ...identity, access_token: TOKEN, token: { ...identity.token, secret: TOKEN } }))
  await saveCredential(context.config, 'author', TOKEN, identity, 'file')
  const result = await runAuth('status', {}, context)
  assert.equal(result.verified, true)
  assert.ok(!JSON.stringify(result).includes(TOKEN))
  const offline = await runAuth('status', { offline: true }, context)
  assert.equal(offline.verified, false)
  assert.equal(context.calls.length, 1)
})

test('logout distinguishes local removal from failed server revocation', async t => {
  const context = fixture(t, () => { throw new Error('server unavailable') })
  await saveCredential(context.config, 'author', TOKEN, identity, 'file')
  const result = await runAuth('logout', {}, context)
  assert.equal(result.localRemoved, true)
  assert.equal(result.revoked, false)
  assert.equal(result.revocation, 'unconfirmed')
  assert.equal(await loadCredential(context.config), null)
})

test('token stdin imports an existing credential without starting device authorization', async t => {
  const context = fixture(t, request => {
    assert.equal(request.route, '/api/v1/auth')
    assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`)
    return response(identity)
  })
  context.stdin = Readable.from([TOKEN + '\n'])
  const result = await runAuth('login', { storage: 'file', tokenStdin: true, nonInteractive: true }, context)
  assert.equal(result.state, 'authenticated')
  assert.equal(context.calls.length, 1)
  assert.equal(context.output(), '')
})

test('non-interactive login requires a supplied token before starting browser authorization', async t => {
  const context = fixture(t, () => { throw new Error('must not contact the server') })
  await assert.rejects(runAuth('login', { nonInteractive: true }, context), { code: 'INTERACTION_REQUIRED' })
  assert.equal(context.calls.length, 0)
  assert.equal(context.output(), '')
})

test('an environment credential does not inherit or remove a different saved identity', async t => {
  const context = fixture(t, request => {
    assert.equal(request.route, '/api/v1/auth/token')
    assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`)
    return response({ revoked: true })
  })
  await saveCredential(context.config, 'author', OLD_TOKEN, identity, 'file')
  context.env.SPECDOC_TOKEN = TOKEN
  context.env.SPECDOC_EDITOR_URL = context.config.editorOrigin
  const offline = await runAuth('status', { offline: true }, context)
  assert.equal(offline.credentialSource, 'environment')
  assert.equal(offline.user, undefined)
  assert.equal(offline.token, undefined)
  assert.equal(context.calls.length, 0)
  const result = await runAuth('logout', {}, context)
  assert.equal(result.revoked, true)
  assert.equal(result.localRemoved, false)
  assert.equal(result.storedCredentialRetained, true)
  assert.equal(result.environmentStillSet, true)
  assert.equal((await loadStoredCredential(context.config)).secret, OLD_TOKEN)
})

test('failed replacement keyring storage preserves the previous slot and cancels the grant', async t => {
  const passwords = new Map()
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') return response(device)
    if (request.route === '/oauth/token') return response({ access_token: TOKEN, ...identity })
    if (request.route === '/oauth/device/cancel') return response({ cancelled: true, revoked: true })
    throw new Error('unexpected request')
  })
  context.config.keyringFactory = class {
    constructor (service, account) { this.account = account }
    async setPassword (password) {
      passwords.set(this.account, password)
      if (password.includes(TOKEN)) throw new Error('lost response after commit')
    }
    async getPassword () { return passwords.get(this.account) || null }
    async deleteCredential () { return passwords.delete(this.account) }
  }
  await saveCredential(context.config, 'author', OLD_TOKEN, identity, 'keyring')
  const previousSlot = context.config.profileData.credentials.author.slot
  await assert.rejects(runAuth('login', {}, context), { code: 'KEYRING_UNAVAILABLE' })
  assert.equal(context.config.profileData.credentials.author.slot, previousSlot)
  assert.equal(await loadCredential(context.config), OLD_TOKEN)
  assert.equal(passwords.size, 1)
  assert.equal(context.calls.at(-1).route, '/oauth/device/cancel')
})

test('successful keyring replacement switches the profile before clearing the previous slot', async t => {
  const passwords = new Map()
  const context = fixture(t, request => {
    if (request.route === '/oauth/device/code') return response(device)
    if (request.route === '/oauth/token') return response({ access_token: TOKEN, ...identity })
    throw new Error('unexpected request')
  })
  context.config.keyringFactory = class {
    constructor (service, account) { this.account = account }
    async setPassword (password) { passwords.set(this.account, password) }
    async getPassword () { return passwords.get(this.account) || null }
    async deleteCredential () { return passwords.delete(this.account) }
  }
  await saveCredential(context.config, 'author', OLD_TOKEN, identity, 'keyring')
  const previousSlot = context.config.profileData.credentials.author.slot
  await runAuth('login', {}, context)
  const persisted = readConfig(context.env).profiles.default.credentials.author
  assert.notEqual(persisted.slot, previousSlot)
  assert.equal(await loadCredential(context.config), TOKEN)
  assert.equal(passwords.size, 1)
})
