const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')

const target = { namespace: 'team/specs', targetRepo: 'team/docs', paths: ['guide.md'], exclude: [], bot: 'docs-bot' }
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

function load (environment = {}) {
  const state = { ticks: 0, locked: false, available: true, modelCalls: 0, budgetCalls: 0 }
  class Pool extends EventEmitter {
    async query () { throw new Error('Unexpected database request') }
    async connect () {
      const client = new EventEmitter()
      client.query = async sql => {
        if (sql.startsWith('SELECT pg_try_advisory_lock(')) { state.locked = state.available; return { rows: [{ ok: state.available }] } }
        if (sql === 'SELECT pg_advisory_unlock_all()') { state.locked = false; return { rows: [] } }
        throw new Error('Unexpected lock request')
      }
      client.release = () => {}
      return client
    }
  }
  const values = { NAMESPACES: 'team/specs', DEFAULT_NAMESPACE: 'team/specs', DOCUMENTATION_FOLLOWUPS: JSON.stringify([target]),
    PR_INTAKE: undefined, GITHUB_TOKEN: 'fallback-must-not-be-used', GITHUB_APP_ID: '11',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SESSION_SECRET: 'docs-server-fixture', SMTP_HOST: undefined, WEBHOOK_URL: undefined, ...environment }
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  const file = path.join(__dirname, 'server.js')
  const fixture = new Module(file + '.docs-server-test', module)
  fixture.filename = file
  fixture.paths = Module._nodeModulePaths(__dirname)
  const real = fixture.require.bind(fixture)
  fixture.require = name => {
    if (name === 'pg') return { Pool }
    if (name === './docs-followup-store') return { createDocsFollowupStore: () => ({ cleanup: async () => {
      state.cleanups = (state.cleanups || 0) + 1
      if (state.cleanupError) throw state.cleanupError
    } }) }
    if (name === './docs-followup-service') return { createDocsFollowupService: deps => {
      state.deps = deps
      return { tick: async () => { assert.equal(state.locked, true); state.ticks++ }, status: {} }
    } }
    if (name === './docs-followup-github') return { createDocumentationGitHub: options => options }
    if (name === './model-budget') return { ...real(name), reserveModelBudget: async (db, scopes) => {
      state.budgetCalls++
      state.budgetScopes = scopes
      return { releaseTokens: async () => {} }
    } }
    if (name === './moderation') return { ...real(name), assertAutomationContext: async () => {} }
    if (name === './model-client') return { ...real(name), endpoint: () => {}, modelRequest: async (url, payload, options) => {
      state.modelCalls++; state.modelSignal = options.signal
      if (state.modelError) throw state.modelError
      return { answer: 'fixture' }
    } }
    return real(name)
  }
  try {
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : (process.env[key] = value)
    fixture._compile(fs.readFileSync(file, 'utf8') + `
      module.exports.docsFixture={documentationGitHub,documentationAuth,documentationRoles,callBotJson,cleanupDocumentation,
        run:runDocumentationFollowups,runLocked:()=>withAdvisoryLock(false,runDocumentationFollowups),health,
        rolesCache,rolesStale,botHealth,reviewFailedBots,feedbackModelCall,
        budget:()=>reviewBudget,setBudget:value=>{reviewBudget=value}};`, file)
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : (process.env[key] = value)
  }
  return { ...fixture.exports.docsFixture, state }
}

test('deployment config defaults disabled and rejects out-of-scope targets', async () => {
  const disabled = load({ DOCUMENTATION_FOLLOWUPS: undefined })
  assert.deepEqual(disabled.state.deps.targets, [])
  await disabled.runLocked()
  assert.equal(disabled.state.ticks, 1, 'disabled targets still reconcile stored work under the leadership lock')
  assert.equal(disabled.health.get('documentation').enabled, false)
  assert.throws(() => load({ DOCUMENTATION_FOLLOWUPS: JSON.stringify([{ ...target, namespace: 'other/specs' }]) }), /namespace must be configured/)
})

test('documentation tick requires the existing poll leadership lock', async () => {
  const fixture = load()
  await fixture.run()
  assert.equal(fixture.state.ticks, 0)
  await fixture.runLocked()
  assert.equal(fixture.state.ticks, 1)
  fixture.state.available = false
  await fixture.runLocked()
  assert.equal(fixture.state.ticks, 1)
})

test('normal documentation work cannot clear a failed retention operation', async () => {
  const fixture = load()
  fixture.state.cleanupError = Object.assign(new Error('Retention is unavailable.'), { code: '42501' })
  await fixture.cleanupDocumentation()
  fixture.health.success('documentation', { completed: 1 })
  assert.equal(fixture.health.get('documentation').ok, true)
  assert.equal(fixture.health.get('documentationRetention').ok, false)
  assert.equal(fixture.health.get('documentationRetention').error, '42501')
  fixture.state.cleanupError = null
  await fixture.cleanupDocumentation()
  assert.equal(fixture.health.get('documentationRetention').ok, true)
  assert.equal(fixture.state.cleanups, 2)
})

test('documentation transport never falls back to the configured PAT and forwards cancellation', async t => {
  const fixture = load()
  let calls = 0
  let signal
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.github.com/repos/team/docs')
    assert.equal(options.headers.authorization, 'Bearer limited-token')
    assert.equal(options.headers['x-github-api-version'], '2022-11-28')
    assert.equal(options.redirect, 'error')
    signal = options.signal
    return { ok: true, headers: new Headers(), json: async () => ({ private: false }) }
  })
  await assert.rejects(fixture.documentationGitHub('GET', '/repos/team/docs', null, ''), { code: 'docs-auth-credentials' })
  assert.equal(calls, 0)
  const controller = new AbortController()
  await fixture.documentationGitHub('GET', '/repos/team/docs', null, 'limited-token', { signal: controller.signal })
  assert.equal(signal.aborted, false)
  controller.abort()
  assert.equal(signal.aborted, true)
  await assert.rejects(fixture.documentationGitHub('GET', '/repos/team/docs', null, 'limited-token', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(calls, 1)
  const missing = load({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined })
  await assert.rejects(missing.documentationRoles('team/specs', true), { code: 'docs-auth-credentials' })
  assert.equal(calls, 1, 'policy reads also require App credentials')
})

test('actual model wrapper combines the worker deadline with normal cancellation', async () => {
  const fixture = load()
  const controller = new AbortController()
  const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'fixture', api_key: null, namespaces: ['team/specs'] }
  await fixture.callBotJson(bot, 'Summarize.', 'Public text.', 'docs', { type: 'object' }, 20, { signal: controller.signal })
  assert.equal(fixture.state.modelCalls, 1)
  controller.abort()
  assert.equal(fixture.state.modelSignal.aborted, true)
  await assert.rejects(fixture.callBotJson(bot, 'Summarize.', 'Public text.', 'docs', {}, 20, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(fixture.state.modelCalls, 1)
  assert.equal(fixture.state.budgetCalls, 1, 'an expired deadline cannot reserve another model budget')
})

test('documentation uses the configured namespace spelling for the shared project budget', async () => {
  const fixture = load({ NAMESPACES: 'Team/Specs', DEFAULT_NAMESPACE: 'Team/Specs' })
  fixture.setBudget(4)
  const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'fixture', api_key: null,
    namespaces: ['team/specs'], budgetNamespaces: ['team/specs'] }
  await fixture.state.deps.modelCall(bot, 'Summarize.', 'Public text.', 'docs', { type: 'object' }, 20)
  assert.deepEqual(fixture.state.budgetScopes, ['Team/Specs'])
  assert.equal(fixture.state.deps.assessmentMs, 180000)
})

function appApi (t) {
  const policy = { approvers: [7], authors: [7], 'implementation-repos': ['team/app'] }
  const state = { mints: 0, policyReads: 0, apps: 0, policy, policyError: null }
  t.mock.method(global, 'fetch', async (url, options) => {
    const route = new URL(url).pathname
    let result
    if (route === '/app') { state.apps++; result = { id: 11, slug: 'docs-app' } }
    else if (route === '/repos/team/specs/installation') result = { id: 22, app_id: 11, suspended_at: null,
      account: { id: 33, login: 'team', type: 'Organization' }, permissions: { contents: 'write' } }
    else if (route === '/app/installations/22/access_tokens') {
      state.mints++
      const body = JSON.parse(options.body)
      assert.deepEqual(body.repositories, ['specs'])
      result = { token: 'scoped-token-' + state.mints, expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions, repositories: [{ id: 44, full_name: 'team/specs', owner: { id: 33, login: 'team', type: 'Organization' } }] }
    } else if (route === '/users/docs-app%5Bbot%5D') result = { id: 77, login: 'docs-app[bot]', type: 'Bot' }
    else if (route === '/repos/team/specs') result = { full_name: 'team/specs', private: false, visibility: 'public' }
    else if (route === '/repos/team/specs/contents/.specs/roles.yml') {
      state.policyReads++
      if (state.policyError) throw state.policyError
      const text = JSON.stringify(state.policy)
      result = { content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) }
    } else throw new Error('Unexpected fixture route: ' + route)
    return { ok: true, headers: new Headers(), json: async () => result }
  })
  return state
}

test('documentation policy failures and fresh reads leave the approval policy cache unchanged', async t => {
  const api = appApi(t)
  const fixture = load()
  const cached = { roles: { approvers: [9], authors: [9] }, at: Date.now(), successAt: Date.now(), failed: false }
  fixture.rolesCache.set('team/specs', cached)
  const signal = new AbortController().signal
  assert.deepEqual((await fixture.documentationRoles('team/specs', true, { signal }))['implementation-repos'], ['team/app'])
  assert.equal(fixture.rolesCache.get('team/specs'), cached, 'docs scope reads cannot replace approval governance')
  for (const error of [new Error('scoped token request failed'), new DOMException('step deadline', 'AbortError')]) {
    api.policyError = error
    await assert.rejects(fixture.documentationRoles('team/specs', true, { signal }))
    assert.equal(fixture.rolesCache.get('team/specs'), cached)
    assert.equal(fixture.rolesStale('team/specs'), false, 'a docs failure cannot withhold unrelated approvals or publication')
  }
})

test('one bounded docs step reuses its App grant while every write guard rereads policy', async t => {
  const api = appApi(t)
  const fixture = load()
  const signal = new AbortController().signal
  await fixture.documentationRoles('team/specs', true, { signal })
  api.policy = { ...api.policy, 'implementation-repos': ['team/replacement'] }
  assert.deepEqual((await fixture.documentationRoles('team/specs', true, { signal }))['implementation-repos'], ['team/replacement'])
  const provider = fixture.state.deps.createProvider(target, {}, { signal, progress: () => {} })
  await provider.authenticate('team/specs', { contents: 'read' })
  assert.equal(api.policyReads, 2)
  assert.equal(api.mints, 1)
  assert.equal(api.apps, 1)
  await fixture.documentationRoles('team/specs', true, { signal: new AbortController().signal })
  assert.equal(api.mints, 2, 'the next step rechecks App and installation authorization')
})

test('documentation distinguishes invalid model output from unavailable transport', async () => {
  for (const response_format of ['json_schema', 'json_object']) {
    const fixture = load()
    fixture.setBudget(4)
    const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'fixture', api_key: null,
      namespaces: ['team/specs'], response_format }
    await assert.rejects(fixture.state.deps.modelCall(bot, 'Summarize.', 'Public text.', 'docs',
      { type: 'object', required: ['needed'], properties: { needed: { type: 'boolean' } } }, 20),
      { code: 'docs-model-invalid' })
    assert.equal(fixture.state.modelCalls, 1)
    assert.equal(fixture.budget(), 3)
  }
})

test('docs model failures consume shared budgets without changing review-bot health or sending alerts', async t => {
  let alerts = 0
  t.mock.method(global, 'fetch', async () => { alerts++; return { ok: true } })
  for (const error of [new DOMException('Documentation deadline expired.', 'TimeoutError'), new Error('Transport unavailable.'),
    Object.assign(new Error('Invalid documentation output.'), { code: 'docs-model-invalid' })]) {
    const fixture = load({ WEBHOOK_URL: 'https://hooks.invalid/events' })
    fixture.setBudget(4)
    const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'fixture', api_key: null, namespaces: ['team/specs'] }
    const args = [bot, 'Summarize.', 'Public text.', 'docs', { type: 'object' }, 20]
    fixture.state.modelError = error
    await assert.rejects(fixture.state.deps.modelCall(...args), thrown => thrown === error)
    assert.equal(fixture.budget(), 3)
    assert.equal(fixture.state.budgetCalls, 1)
    assert.equal(fixture.botHealth.size, 0)
    assert.equal(fixture.reviewFailedBots.size, 0)
    assert.equal(alerts, 0)
    fixture.state.modelError = null
    await fixture.feedbackModelCall(...args)
    assert.equal(fixture.budget(), 2, 'review and docs work use the same poll allowance')
    const reviewHealth = { failures: 1, retryTick: 0 }
    fixture.botHealth.set(bot.name, reviewHealth)
    await fixture.state.deps.modelCall(...args)
    assert.equal(fixture.botHealth.get(bot.name), reviewHealth, 'docs success cannot clear a review failure')
    fixture.setBudget(0)
    const calls = fixture.state.modelCalls
    await assert.rejects(fixture.state.deps.modelCall(...args), { code: 'budget' })
    assert.equal(fixture.state.modelCalls, calls)
  }
})
