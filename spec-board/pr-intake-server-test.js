'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { test } = require('node:test')

const policy = { namespace: 'team/specs', organizationId: '33', botId: '55', proposalUrl: 'https://board.example.test/?ns=team%2Fspecs' }
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const afterIntake = new Error('Fixture stopped before unrelated publication work')

function loadServer (environment = {}) {
  const state = { locked: false, available: true, released: false, client: null }
  class Pool extends EventEmitter {
    async query (sql) {
      if (sql.includes("to_regclass('spec_board_state_ns_pr')")) return { rows: [{
        indisvalid: true, indisunique: true, indnkeyatts: 2, plain_columns: true,
        columns: ['namespace', 'pr_number'], predicate: '(pr_number IS NOT NULL)'
      }] }
      if (sql.startsWith('DELETE FROM spec_board_state s')) throw afterIntake
      if (sql.startsWith('DELETE FROM spec_board_moderation_reports') ||
          sql.startsWith('SELECT note_id FROM (') || sql.startsWith('DELETE FROM spec_board_review_reminders') ||
          /^DELETE FROM spec_board_review_(actor|attempt)_budget /.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unexpected fixture query: ${sql}`)
    }

    async connect () {
      const client = new EventEmitter()
      client.query = async sql => {
        if (sql.startsWith('SELECT pg_try_advisory_lock(')) {
          state.locked = state.available
          return { rows: [{ ok: state.available }] }
        }
        if (sql === 'SELECT pg_advisory_unlock_all()') {
          state.locked = false
          return { rows: [] }
        }
        throw new Error(`Unexpected fixture lock query: ${sql}`)
      }
      client.release = () => { state.released = true }
      state.client = client
      return client
    }
  }

  const values = { NAMESPACES: 'team/specs', DEFAULT_NAMESPACE: 'team/specs', PR_INTAKE: undefined, DOCUMENTATION_FOLLOWUPS: undefined,
    GITHUB_TOKEN: 'pat-fixture-must-not-be-used', GITHUB_APP_ID: '11',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SESSION_SECRET: 'intake-server-fixture', SMTP_HOST: undefined, ...environment }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  const file = path.join(__dirname, 'server.js')
  const fixture = new Module(file + '.intake-server-test', module)
  fixture.filename = file
  fixture.paths = Module._nodeModulePaths(__dirname)
  const requireModule = fixture.require.bind(fixture)
  fixture.require = name => name === 'pg' ? { Pool } : name === './docs-followup-store'
    ? { createDocsFollowupStore: () => ({ cleanup: async () => 0 }) } : requireModule(name)
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fixture._compile(fs.readFileSync(file, 'utf8') + `
      module.exports.intakeFixture = {
        intakeGitHub, prIntake, health, serviceTokenFor, namespaceRoles, rolesStale,
        runPoll: () => withAdvisoryLock(false, pollTick)
      };`, file)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { ...fixture.exports.intakeFixture, state }
}

function response (body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(),
    json: async () => structuredClone(body), text: async () => 'fixture response' }
}

function githubFixture (t, fixture, onRequest = () => {}) {
  const calls = []
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(fixture.state.locked, true, 'intake must run under the poll leader lock')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    const pathname = new URL(url).pathname
    const token = options.headers.authorization.slice('Bearer '.length)
    calls.push({ pathname, method: options.method, token })
    onRequest(pathname)
    if (['/app', '/repos/team/specs/installation', '/app/installations/22/access_tokens'].includes(pathname)) {
      const [header, payload, signature] = token.split('.')
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')))
      assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '11')
    } else assert.equal(token, 'restricted-fixture')
    switch (pathname) {
      case '/app': return response({ id: 11, slug: 'review-bot' })
      case '/repos/team/specs/installation': return response({ id: 22, app_id: 11, suspended_at: null,
        account: { id: 33, type: 'Organization', login: 'team' }, permissions: { members: 'read', pull_requests: 'write' } })
      case '/app/installations/22/access_tokens': {
        assert.deepEqual(JSON.parse(options.body), { repositories: ['specs'],
          permissions: { members: 'read', pull_requests: 'write', metadata: 'read' } })
        return response({ token: 'restricted-fixture', expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { members: 'read', pull_requests: 'write', metadata: 'read' },
          repositories: [{ id: 44, full_name: 'team/specs', owner: { id: 33, type: 'Organization', login: 'team' } }] })
      }
      case '/users/review-bot%5Bbot%5D': return response({ id: 55, type: 'Bot', login: 'review-bot[bot]' })
      case '/repos/team/specs/pulls': return response([{ number: 7 }])
      case '/repos/team/specs/pulls/7': return response({ number: 7, state: 'open',
        user: { id: 66, type: 'User', login: 'private-member' },
        base: { repo: { full_name: 'team/specs', owner: { id: 33, type: 'Organization', login: 'team' } } } })
      case '/orgs/team/memberships/private-member': return response({ state: 'active', role: 'member',
        user: { id: 66, type: 'User', login: 'private-member' }, organization: { id: 33, login: 'team' } })
      default: throw new Error(`Unexpected fetch: ${url}`)
    }
  })
  return calls
}

test('server intake is disabled by default and rejects policies outside its namespaces', async t => {
  const fetch = t.mock.method(global, 'fetch', () => { throw new Error('Unexpected network request') })
  const fixture = loadServer()
  await assert.rejects(fixture.runPoll(), error => error === afterIntake)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(fixture.health.status().prIntake.enabled, false)
  assert.throws(() => loadServer({ PR_INTAKE: '{' }), { code: 'pr_intake_config' })
  assert.throws(() => loadServer({ PR_INTAKE: JSON.stringify([{ ...policy, namespace: 'another/specs' }]) }), { code: 'pr_intake_config' })
})

test('the server transport rejects absent tokens before its generic PAT fallback and refuses redirects', async t => {
  const fetch = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/orgs/team/memberships/member')
    assert.equal(options.headers.authorization, 'Bearer restricted-fixture')
    assert.equal(options.redirect, 'error')
    return response({}, 302)
  })
  const fixture = loadServer()
  for (const token of [undefined, null, '', 0]) {
    assert.throws(() => fixture.intakeGitHub('GET', '/orgs/team/memberships/member', null, token), /explicit GitHub App token/)
  }
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(fixture.intakeGitHub('GET', '/orgs/team/memberships/member', null, 'restricted-fixture'), { status: 302 })
  assert.equal(fetch.mock.callCount(), 1)
})

test('the poll leader invokes configured intake and uses the App grant for private membership', async t => {
  const fixture = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  const calls = githubFixture(t, fixture)
  await assert.rejects(fixture.runPoll(), error => error === afterIntake)
  assert.ok(calls.some(call => call.pathname === '/orgs/team/memberships/private-member'))
  assert.ok(calls.every(call => call.method === 'GET' || call.pathname === '/app/installations/22/access_tokens'))
  assert.equal(fixture.health.status().prIntake.ok, true)
  assert.equal(fixture.state.released, true)
  assert.equal(fixture.state.locked, false)
})

test('a follower cannot invoke intake and leadership loss stops subsequent GitHub calls', async t => {
  const follower = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  follower.state.available = false
  const calls = githubFixture(t, follower)
  assert.equal(await follower.runPoll(), false)
  assert.equal(calls.length, 0)

  const leader = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  const interrupted = githubFixture(t, leader, pathname => {
    if (pathname === '/repos/team/specs/pulls') leader.state.client.emit('error', new Error('Fixture lost its leader connection'))
  })
  await assert.rejects(leader.runPoll(), error => error === afterIntake)
  assert.equal(interrupted.at(-1).pathname, '/repos/team/specs/pulls')
  assert.equal(leader.health.status().prIntake.ok, false)
  assert.equal(leader.state.released, true)
})

test('configured intake without App credentials leaves PRs untouched despite a configured PAT', async t => {
  const fetch = t.mock.method(global, 'fetch', () => { throw new Error('Unexpected credential fallback') })
  const fixture = loadServer({ PR_INTAKE: JSON.stringify([policy]), GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined })
  await assert.rejects(fixture.runPoll(), error => error === afterIntake)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(fixture.health.status().prIntake.ok, false)
})

test('publishing to an intake namespace requires App credentials while other namespaces retain PAT support', async t => {
  const fetch = t.mock.method(global, 'fetch', () => { throw new Error('Unexpected credential fallback') })
  t.mock.method(console, 'warn', () => {})
  for (const missing of [
    { GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined },
    { GITHUB_APP_ID: undefined }, { GITHUB_APP_PRIVATE_KEY: undefined }
  ]) {
    const fixture = loadServer({ PR_INTAKE: JSON.stringify([policy]), ...missing })
    await assert.rejects(fixture.serviceTokenFor('team/specs'))
    assert.equal(await fixture.serviceTokenFor('another/specs'), 'pat-fixture-must-not-be-used')
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('intake publication never falls back to a PAT after installation or token errors', async t => {
  let failMint = false, status = 404
  const calls = []
  t.mock.method(console, 'error', () => {})
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method })
    assert.notEqual(options.headers.authorization, 'Bearer pat-fixture-must-not-be-used')
    if (failMint && url.endsWith('/installation')) return response({ id: 22 })
    return response({}, status)
  })
  for (status of [404, 500]) {
    for (failMint of [false, true]) {
      const fixture = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
      await assert.rejects(fixture.serviceTokenFor('TEAM/SPECS'), {
        status: 503, code: 'github_app_authentication',
        message: 'GitHub App authentication is unavailable for this repository'
      })
      assert.equal(await fixture.serviceTokenFor('another/specs'), 'pat-fixture-must-not-be-used')
    }
  }
  assert.ok(calls.some(call => call.url.endsWith('/app/installations/22/access_tokens')))
})

test('intake namespace publication still obtains and reuses a valid App installation token', async t => {
  const calls = []
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, method: options.method })
    const token = options.headers.authorization.slice('Bearer '.length)
    const [header, payload, signature] = token.split('.')
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')))
    if (url === 'https://api.github.com/repos/team/specs/installation') return response({ id: 22 })
    assert.equal(url, 'https://api.github.com/app/installations/22/access_tokens')
    assert.equal(options.method, 'POST')
    return response({ token: 'publication-app-fixture', expires_at: new Date(Date.now() + 3600000).toISOString() })
  })
  const fixture = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  assert.equal(await fixture.serviceTokenFor('team/specs'), 'publication-app-fixture')
  assert.equal(await fixture.serviceTokenFor('team/specs'), 'publication-app-fixture')
  assert.equal(calls.length, 2)
})

test('installation authentication failures leave governance unknown rather than caching an absent policy', async t => {
  let unavailable = true, now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const logs = []
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')) })
  t.mock.method(global, 'fetch', async url => {
    if (url.endsWith('/installation')) return unavailable
      ? { ...response({}, 404), text: async () => 'private upstream diagnostic' }
      : response({ id: 22 })
    if (url.endsWith('/access_tokens')) return response({ token: 'publication-fixture', expires_at: new Date(now + 61000).toISOString() })
    assert.equal(url, 'https://api.github.com/repos/team/specs/contents/.specs/roles.yml')
    return response({ content: Buffer.from(JSON.stringify({ approvers: ['55'], 'approvals-required': 1 })).toString('base64') })
  })
  const cold = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  assert.equal(await cold.namespaceRoles('team/specs'), undefined)
  assert.equal(cold.rolesStale('team/specs'), true)

  unavailable = false
  const warm = loadServer({ PR_INTAKE: JSON.stringify([policy]) })
  const previous = await warm.namespaceRoles('team/specs')
  assert.deepEqual(previous.approvers, ['55'])
  assert.equal(warm.rolesStale('team/specs'), false)
  now += 2000
  unavailable = true
  assert.deepEqual(await warm.namespaceRoles('team/specs', false, true), previous)
  assert.equal(warm.rolesStale('team/specs'), true)
  assert.ok(logs.length > 0)
  assert.ok(logs.every(line => !line.includes('private upstream diagnostic')))
})

test('the GitHub transport preserves rate-limit retry times and pauses only the affected credential', async t => {
  const start = Math.floor(Date.now() / 1000) * 1000
  let now = start, headers, status, recovered = false
  t.mock.method(Date, 'now', () => now)
  const fetch = t.mock.method(global, 'fetch', async (url, options) => {
    if (recovered || options.headers.authorization === 'Bearer another-fixture') return response({ ok: true })
    return { ...response({}, status), headers: new Headers(headers) }
  })
  const cases = [
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 60) }, delay: 60000 },
    { status: 429, headers: { 'retry-after': '45' }, delay: 45000 },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start / 1000 + 60), 'retry-after': '120' }, delay: 120000 },
    { status: 429, headers: { 'retry-after': '172800' }, delay: 86400000 }
  ]
  for (const value of cases) {
    now = start
    recovered = false
    ;({ headers, status } = value)
    const fixture = loadServer()
    const before = fetch.mock.callCount()
    const call = token => fixture.intakeGitHub('GET', '/orgs/team/memberships/member', null, token)
    await assert.rejects(call('limited-fixture'), { status, retryAt: start + value.delay })
    await assert.rejects(call('limited-fixture'), { status: 429, retryAt: start + value.delay })
    assert.equal(fetch.mock.callCount(), before + 1)
    assert.deepEqual(await call('another-fixture'), { ok: true })
    now = start + value.delay + 1
    recovered = true
    assert.deepEqual(await call('limited-fixture'), { ok: true })
    assert.equal(fetch.mock.callCount(), before + 3)
  }
})

test('malformed or expired rate-limit metadata does not pause the credential or break error reporting', async t => {
  const now = Math.floor(Date.now() / 1000) * 1000
  t.mock.method(Date, 'now', () => now)
  let headers, status = 429
  const fetch = t.mock.method(global, 'fetch', async () => ({ ...response({}, status), headers: new Headers(headers) }))
  const cases = [
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'NaN', 'retry-after': 'invalid' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Number.MAX_SAFE_INTEGER), 'retry-after': 'Infinity' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 - 1), 'retry-after': '-1' },
    { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': String(now / 1000 + 60) }
  ]
  for (headers of cases) {
    const fixture = loadServer()
    const before = fetch.mock.callCount()
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(fixture.intakeGitHub('GET', '/orgs/team/memberships/member', null, 'limited-fixture'), error =>
        error.status === status && error.retryAt === undefined)
    }
    assert.equal(fetch.mock.callCount(), before + 2)
  }
  status = 500
  headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 60), 'retry-after': '120' }
  const fixture = loadServer()
  await assert.rejects(fixture.intakeGitHub('GET', '/orgs/team/memberships/member', null, 'limited-fixture'), error =>
    error.status === 500 && error.retryAt === undefined)
})
