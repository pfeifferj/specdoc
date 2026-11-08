const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createDocumentationAuth } = require('./docs-followup-auth')

function fixture (change = () => {}, options = {}) {
  let time = Date.parse('2026-11-08T12:00:00Z')
  const calls = []
  const account = { id: 33, type: options.accountType || 'Organization', login: 'team' }
  const replies = {
    '/app': { id: 11, client_id: 'Iv23.exampleClientId', slug: 'docs-app' },
    '/repos/team/docs/installation': { id: 22, app_id: 11, account, suspended_at: null,
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' } },
    '/users/docs-app%5Bbot%5D': { id: 77, type: 'Bot', login: 'docs-app[bot]' }
  }
  const authenticate = createDocumentationAuth({ appId: options.appId || '11', enabled: options.enabled !== false,
    jwt: options.jwt || (() => 'signed-app-assertion'), now: () => time, signal: options.signal,
    github: async (method, path, body, token, requestOptions) => {
      calls.push({ method, path, body, token, requestOptions })
      if (path === '/users/docs-app%5Bbot%5D') assert.equal(token, 'restricted-installation-token')
      else assert.equal(token, 'signed-app-assertion')
      let result
      if (path === '/app/installations/22/access_tokens') {
        assert.equal(method, 'POST')
        assert.deepEqual(body.repositories, ['docs'])
        result = { token: 'restricted-installation-token', expires_at: new Date(time + 3600000).toISOString(),
          permissions: { ...body.permissions }, repositories: [{ id: 44, full_name: 'team/docs', owner: { ...account } }] }
      } else { assert.equal(method, 'GET'); result = structuredClone(replies[path]) }
      if (!result) throw new Error('Unexpected route: ' + path)
      change(result, path)
      return result
    } })
  return { authenticate, calls, advance: milliseconds => { time += milliseconds } }
}

test('requests and verifies a single-repository permission grant and actual App bot identity', async () => {
  const f = fixture()
  const auth = await f.authenticate('team/docs', { contents: 'write', pull_requests: 'write' })
  assert.deepEqual(auth, { token: 'restricted-installation-token', botId: 77, botLogin: 'docs-app[bot]' })
  assert.deepEqual(f.calls[2].body.permissions, { contents: 'write', metadata: 'read', pull_requests: 'write' })
  assert.equal(f.calls[3].token, auth.token, 'App assertions never authenticate ordinary user lookups')
  assert.equal((await f.authenticate('team/docs', { pull_requests: 'write', contents: 'write' })).botId, 77)
  assert.equal(f.calls.length, 4)
  await f.authenticate('team/docs', { contents: 'read' })
  assert.equal(f.calls.length, 7, 'different requested permissions receive a separate narrowed token')
  f.advance(300001)
  await f.authenticate('team/docs', { contents: 'read' })
  assert.equal(f.calls.length, 10, 'expired local grants are refreshed')
})

test('accepts a personal repository owner and a documented App client ID', async () => {
  const f = fixture(() => {}, { accountType: 'User', appId: 'Iv23.exampleClientId' })
  assert.equal((await f.authenticate('team/docs', { contents: 'read' })).botId, 77)
})

test('missing credentials, invalid permissions and cancellation make no API request', async () => {
  for (const options of [{ enabled: false }, { jwt: () => '' }]) {
    const f = fixture(() => {}, options)
    await assert.rejects(f.authenticate('team/docs', { contents: 'read' }), { code: 'docs-auth-credentials' })
    assert.equal(f.calls.length, 0)
  }
  for (const permissions of [{ administration: 'write' }, { metadata: 'write' }, { contents: 'admin' }, null]) {
    const f = fixture()
    await assert.rejects(f.authenticate('team/docs', permissions), { code: 'docs-auth-permissions' })
    assert.equal(f.calls.length, 0)
  }
  const controller = new AbortController(); controller.abort()
  const f = fixture(() => {}, { signal: controller.signal })
  await assert.rejects(f.authenticate('team/docs', { contents: 'read' }), { name: 'AbortError' })
  assert.equal(f.calls.length, 0)
})

test('rejects mismatched App, installation, token scope and bot identity', async () => {
  const cases = [
    ['/app', r => { r.id = 12 }, 'identity'],
    ['/app', r => { r.id = '11' }, 'identity'],
    ['/app', r => { r.slug = '../other' }, 'identity'],
    ['/repos/team/docs/installation', r => { r.app_id = 12 }, 'installation'],
    ['/repos/team/docs/installation', r => { r.account.id = '33' }, 'installation'],
    ['/repos/team/docs/installation', r => { r.account.login = 'another' }, 'installation'],
    ['/repos/team/docs/installation', r => { r.suspended_at = '2026-11-08' }, 'installation'],
    ['/repos/team/docs/installation', r => { r.permissions.contents = 'read' }, 'installation-permissions'],
    ['/app/installations/22/access_tokens', r => { r.permissions.issues = 'write' }, 'token-permissions'],
    ['/app/installations/22/access_tokens', r => { r.permissions.contents = 'read' }, 'token-permissions'],
    ['/app/installations/22/access_tokens', r => { r.repositories.push({ ...r.repositories[0] }) }, 'token-repositories'],
    ['/app/installations/22/access_tokens', r => { r.repositories[0].full_name = 'team/other' }, 'token-repositories'],
    ['/app/installations/22/access_tokens', r => { r.repositories[0].owner.id = 34 }, 'token-repositories'],
    ['/app/installations/22/access_tokens', r => { r.repositories[0].id = '44' }, 'token-repositories'],
    ['/app/installations/22/access_tokens', r => { r.expires_at = 'invalid' }, 'expiry'],
    ['/app/installations/22/access_tokens', r => { r.token = '' }, 'expiry'],
    ['/users/docs-app%5Bbot%5D', r => { r.id = '77' }, 'bot-identity'],
    ['/users/docs-app%5Bbot%5D', r => { r.type = 'User' }, 'bot-identity'],
    ['/users/docs-app%5Bbot%5D', r => { r.login = 'other[bot]' }, 'bot-identity']
  ]
  for (const [route, mutate, code] of cases) {
    const f = fixture((result, path) => { if (path === route) mutate(result) })
    await assert.rejects(f.authenticate('team/docs', { contents: 'write' }), { code: 'docs-auth-' + code }, route + ':' + code)
    assert.ok(f.calls.every(call => call.token !== 'pat-fallback'))
  }
})

test('upstream failures preserve safe retry metadata without echoing credentials or response text', async () => {
  const time = Date.now()
  const authenticate = createDocumentationAuth({ enabled: true, appId: '11', jwt: () => 'jwt', now: () => time,
    github: async () => { throw Object.assign(new Error('credential-bearing upstream response'), { status: 429, retryAt: time + 60000 }) } })
  await assert.rejects(authenticate('team/docs', { contents: 'read' }), error =>
    error.code === 'docs-auth-unavailable' && error.status === 429 && error.retryAt === time + 60000 && !error.message.includes('credential-bearing'))
})
