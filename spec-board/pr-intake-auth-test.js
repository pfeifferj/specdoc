'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createPrIntakeAuth } = require('./pr-intake-auth')

function fixture (options = {}) {
  const state = {
    time: Date.parse('2026-11-07T12:00:00Z'),
    app: { id: 11, client_id: 'Iv00abcdefghijklmnop', slug: 'review-bot' },
    installation: { id: 22, app_id: 11, suspended_at: null,
      account: { id: 33, type: 'Organization', login: 'team' },
      permissions: { members: 'read', pull_requests: 'write', contents: 'write', metadata: 'read' } },
    grant: { token: 'restricted-fixture', expires_at: '2026-11-07T13:00:00Z',
      permissions: { members: 'read', pull_requests: 'write', metadata: 'read' },
      repositories: [{ id: 44, full_name: 'team/specs', owner: { id: 33, type: 'Organization', login: 'team' } }] },
    bot: { id: 55, type: 'Bot', login: 'review-bot[bot]' },
    assertions: ['app-jwt-fixture'], failedPath: null
  }
  const calls = []
  const github = async (method, path, body, token) => {
    calls.push({ method, path, body: structuredClone(body), token })
    if (path === state.failedPath) throw Object.assign(new Error('GitHub request failed'), { status: state.failedStatus || 403 })
    if (method === 'GET' && path === '/app') return structuredClone(state.app)
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return structuredClone(state.installation)
    if (method === 'POST' && path === `/app/installations/${state.installation.id}/access_tokens`) return structuredClone(state.grant)
    if (method === 'GET' && path === '/users/review-bot%5Bbot%5D') return structuredClone(state.bot)
    throw new Error(`Unexpected ${method} ${path}`)
  }
  const authenticate = createPrIntakeAuth({ github,
    jwt: () => state.assertions.length > 1 ? state.assertions.shift() : state.assertions[0],
    appId: '11', enabled: true, now: () => state.time, ...options })
  const policy = { namespace: 'team/specs', organizationId: '33', botId: '55' }
  return { state, calls, policy, authenticate: (value = policy, assertActive) => authenticate(value, assertActive) }
}

test('intake mints only the target repository and permissions, and keeps JWTs off user lookups', async () => {
  const f = fixture()
  assert.deepEqual(await f.authenticate(), { token: 'restricted-fixture', botId: '55' })
  assert.deepEqual(f.calls.map(({ method, path, token }) => ({ method, path, token })), [
    { method: 'GET', path: '/app', token: 'app-jwt-fixture' },
    { method: 'GET', path: '/repos/team/specs/installation', token: 'app-jwt-fixture' },
    { method: 'POST', path: '/app/installations/22/access_tokens', token: 'app-jwt-fixture' },
    { method: 'GET', path: '/users/review-bot%5Bbot%5D', token: 'restricted-fixture' }
  ])
  assert.deepEqual(f.calls[2].body, { repositories: ['specs'],
    permissions: { members: 'read', pull_requests: 'write', metadata: 'read' } })
})

test('numeric App IDs and public client IDs both bind the authenticated App', async () => {
  for (const clientId of ['Iv00abcdefghijklmnop', 'Iv1.ab1112223334445c']) {
    const f = fixture({ appId: clientId })
    f.state.app.client_id = clientId
    assert.equal((await f.authenticate()).botId, '55')
  }
  const changed = fixture()
  changed.state.app.id = 99
  await assert.rejects(changed.authenticate(), { code: 'intake.app_identity' })
  assert.equal(changed.calls.length, 1)
})

test('missing credentials never request a fallback token', async () => {
  for (const options of [{ enabled: false }, { appId: undefined }, { appId: '' }]) {
    const f = fixture(options)
    await assert.rejects(f.authenticate())
    assert.equal(f.calls.length, 0)
  }
  for (const assertions of [[''], [null], ['app-jwt-fixture', '']]) {
    const f = fixture()
    f.state.assertions = assertions
    await assert.rejects(f.authenticate(), { code: 'intake.credentials' })
    assert.ok(f.calls.every(call => call.token === 'app-jwt-fixture'))
    assert.ok(!f.calls.some(call => call.path.includes('/installation')))
  }
})

test('an unrelated, suspended or insufficiently permitted installation cannot mint a token', async () => {
  const changes = [
    s => { s.installation.app_id = 99 },
    s => { s.installation.account.id = 99 },
    s => { s.installation.account.login = 'other-team' },
    s => { s.installation.account.type = 'User' },
    s => { s.installation.suspended_at = '2026-11-07T11:00:00Z' },
    s => { delete s.installation.suspended_at },
    s => { delete s.installation.permissions.members },
    s => { s.installation.permissions.pull_requests = 'read' }
  ]
  for (const change of changes) {
    const f = fixture()
    change(f.state)
    await assert.rejects(f.authenticate())
    assert.ok(!f.calls.some(call => call.method === 'POST'))
  }
})

test('the returned token cannot silently broaden permissions or repository access', async () => {
  const changes = [
    s => { s.grant.permissions.contents = 'write' },
    s => { s.grant.permissions.members = 'write' },
    s => { delete s.grant.permissions.pull_requests },
    s => { s.grant.repositories.push({ ...s.grant.repositories[0], id: 45, full_name: 'team/infra' }) },
    s => { s.grant.repositories[0].full_name = 'team/infra' },
    s => { s.grant.repositories[0].owner.id = 99 },
    s => { s.grant.repositories[0].owner.login = 'other-team' },
    s => { s.grant.repositories[0].owner.type = 'User' },
    s => { delete s.grant.repositories }
  ]
  for (const change of changes) {
    const f = fixture()
    change(f.state)
    await assert.rejects(f.authenticate())
    assert.ok(!f.calls.some(call => call.path.startsWith('/users/')))
  }
})

test('unusable tokens and an unexpected bot identity are never returned or cached', async () => {
  const changes = [
    s => { s.grant.token = '' },
    s => { s.grant.expires_at = 'invalid' },
    s => { s.grant.expires_at = new Date(s.time + 60000).toISOString() },
    s => { s.bot.id = 99 },
    s => { s.bot.type = 'User' },
    s => { s.bot.login = 'another-bot[bot]' }
  ]
  for (const change of changes) {
    const f = fixture()
    const original = structuredClone(f.state)
    change(f.state)
    await assert.rejects(f.authenticate())
    Object.assign(f.state, original)
    assert.equal((await f.authenticate()).token, 'restricted-fixture')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 2)
  }
})

test('malformed API identities cannot pass numeric identity comparisons', async () => {
  const matchingStrings = [
    [s => { s.app.id = '11' }, 'intake.app_identity'],
    [s => { s.installation.id = '22' }, 'intake.installation_identity'],
    [s => { s.installation.account.id = '33' }, 'intake.installation_identity'],
    [s => { s.grant.repositories[0].id = '44' }, 'intake.token_repositories'],
    [s => { s.grant.repositories[0].owner.id = '33' }, 'intake.token_repositories'],
    [s => { s.bot.id = '55' }, 'intake.bot_identity']
  ]
  for (const [mutate, code] of matchingStrings) {
    const f = fixture()
    mutate(f.state)
    await assert.rejects(f.authenticate(), { code })
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    const f = fixture()
    f.state.grant.repositories[0].id = value
    await assert.rejects(f.authenticate(), { code: 'intake.token_repositories' })
  }
})

test('cached authorization expires before the token and rechecks App and installation state', async () => {
  const f = fixture()
  await f.authenticate()
  f.state.time += 299999
  await f.authenticate()
  assert.equal(f.calls.length, 4)
  f.state.time++
  f.state.installation.suspended_at = new Date(f.state.time).toISOString()
  await assert.rejects(f.authenticate(), { code: 'intake.installation_identity' })
  assert.equal(f.calls.filter(call => call.path === '/app').length, 2)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)

  const short = fixture()
  short.state.grant.expires_at = new Date(short.state.time + 120000).toISOString()
  await short.authenticate()
  short.state.time += 60000
  short.state.grant = { ...short.state.grant, token: 'refreshed-fixture', expires_at: new Date(short.state.time + 3600000).toISOString() }
  assert.equal((await short.authenticate()).token, 'refreshed-fixture')
  assert.equal(short.calls.filter(call => call.method === 'POST').length, 2)
})

test('cached authorization is never shared across policy repositories, organizations or bots', async () => {
  for (const change of [{ namespace: 'team/infra' }, { organizationId: '99' }, { botId: '99' }]) {
    const f = fixture()
    await f.authenticate()
    await assert.rejects(f.authenticate({ ...f.policy, ...change }))
    assert.ok(f.calls.length > 4)
  }
})

test('API failures stop authentication without a PAT or another credential path', async () => {
  const paths = ['/app', '/repos/team/specs/installation', '/app/installations/22/access_tokens', '/users/review-bot%5Bbot%5D']
  for (const [index, path] of paths.entries()) {
    for (const status of [401, 403, 404, 429, 500]) {
      const f = fixture()
      f.state.failedPath = path
      f.state.failedStatus = status
      await assert.rejects(f.authenticate(), { status })
      assert.equal(f.calls.length, index + 1)
      assert.ok(f.calls.every(call => call.token === 'app-jwt-fixture' || call.token === 'restricted-fixture'))
    }
  }
})

test('authentication respects the poll budget before reads, token minting and cache reuse', async () => {
  const budget = Object.assign(new Error('Budget exhausted'), { code: 'pr_intake_budget' })
  for (const allowed of [0, 1, 2, 3]) {
    const f = fixture()
    await assert.rejects(f.authenticate(f.policy, () => {
      if (f.calls.length >= allowed) throw budget
    }), { code: 'pr_intake_budget' })
    assert.equal(f.calls.length, allowed)
  }
  const f = fixture()
  await f.authenticate()
  await assert.rejects(f.authenticate(f.policy, () => { throw budget }), { code: 'pr_intake_budget' })
  assert.equal(f.calls.length, 4)
})
