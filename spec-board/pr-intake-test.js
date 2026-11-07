'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHealthState } = require('./health-state')
const { parsePrIntake, createPrIntake } = require('./pr-intake')

const policy = { namespace: 'team/specs', organizationId: '100', botId: '200', proposalUrl: 'https://specs.example.org/?ns=team%2Fspecs' }
const marker = '<!-- specdoc-pr-intake -->'
const tokenFor = policy => `restricted-token:${policy.namespace}`
const absent = () => Object.assign(new Error('private upstream response'), { status: 404 })
const membership = (change = {}) => ({ state: 'active', role: 'member',
  user: { id: 300, login: 'contributor', type: 'User' }, organization: { id: 100, login: 'team' }, ...change })
const comment = (id, body = 'Comment', user = { id: 400, type: 'User' }) => ({ id, body, user })

function fixture (options = {}) {
  const policies = options.policies || [policy]
  const calls = [], reads = new Map(), comments = new Map(), closed = new Set(), fixtureErrors = []
  const expectedLogin = new Map()
  const health = createHealthState()
  const state = { active: true, now: 0, memberReads: 0, authCalls: 0, authPolicy: null,
    failPost: !!options.failPost, failClose: !!options.failClose }
  const key = (namespace, number) => `${namespace}#${number}`
  const respond = async (method, path, body, token) => {
    assert.equal(token, tokenFor(state.authPolicy))
    const repo = policies.find(item => path.startsWith(`/repos/${item.namespace}/`))
    if (path.startsWith('/repos/')) assert.equal(repo?.namespace, state.authPolicy.namespace)
    const repoKey = repo?.namespace || policy.namespace
    const pull = /\/pulls\/(\d+)$/.exec(path)
    const number = pull ? Number(pull[1]) : Number(/\/issues\/(\d+)\//.exec(path)?.[1])
    const id = key(repoKey, number)
    if (options.onRequest) await options.onRequest({ method, path, body, state })
    if (method === 'GET' && path.includes('/pulls?')) {
      const params = new URL(`https://api.github.com${path}`).searchParams
      assert.equal(params.get('state'), 'open')
      assert.equal(params.get('sort'), 'created')
      assert.equal(params.get('direction'), 'asc')
      const size = Number(params.get('per_page'))
      const page = Number(params.get('page'))
      assert.equal(size, 50)
      assert.ok(Number.isSafeInteger(page) && page > 0)
      if (options.list) return options.list(page, repo)
      return (options.numbers || [1]).filter(n => !closed.has(key(repoKey, n))).slice((page - 1) * size, page * size).map(n => ({ number: n }))
    }
    if (method === 'GET' && pull) {
      reads.set(id, (reads.get(id) || 0) + 1)
      const pr = { number, state: closed.has(id) ? 'closed' : 'open', merged_at: null,
        user: { id: 300, login: 'contributor', type: 'User' },
        base: { repo: { full_name: repoKey, owner: { id: Number(repo.organizationId), login: repoKey.split('/')[0], type: 'Organization' } } } }
      if (options.pr) options.pr(pr, reads.get(id), state)
      expectedLogin.set(repoKey.split('/')[0], pr.user?.login)
      return pr
    }
    if (method === 'GET' && path.includes('/memberships/')) {
      const match = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(path)
      assert.ok(match)
      const owner = match[1], login = decodeURIComponent(match[2])
      assert.equal(owner, state.authPolicy.namespace.split('/')[0])
      assert.equal(login, expectedLogin.get(owner))
      state.memberReads++
      const memberships = options.memberships || (Object.hasOwn(options, 'membership') ? { 'team/contributor': options.membership } : {})
      const memberKey = `${owner}/${login}`
      if (!Object.hasOwn(memberships, memberKey)) throw absent()
      const response = memberships[memberKey]
      return typeof response === 'function' ? response(state.memberReads, state) : structuredClone(response)
    }
    if (method === 'GET' && path.includes('/comments?')) {
      const params = new URL(`https://api.github.com${path}`).searchParams
      const size = Number(params.get('per_page'))
      const page = Number(params.get('page'))
      assert.equal(size, 100)
      assert.ok(Number.isSafeInteger(page) && page > 0)
      if (options.commentsPage) return options.commentsPage(page)
      return (comments.get(id) || options.comments || []).slice((page - 1) * size, page * size)
    }
    if (method === 'POST' && path.endsWith('/comments')) {
      comments.set(id, [...(comments.get(id) || options.comments || []), comment(10000, body.body, { id: Number(repo.botId), type: 'Bot' })])
      if (state.failPost) { state.failPost = false; throw new Error('response lost including secret') }
      return { id: 10000 }
    }
    if (method === 'PATCH' && pull) {
      assert.deepEqual(body, { state: 'closed' })
      closed.add(id)
      if (state.failClose) { state.failClose = false; throw new Error('response lost') }
      return { number, state: 'closed' }
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }
  const github = async (method, path, body, token) => {
    calls.push({ method, path, body })
    try { return await respond(method, path, body, token) } catch (error) {
      if (error.code === 'ERR_ASSERTION') fixtureErrors.push(error)
      throw error
    }
  }
  const intake = createPrIntake({ policies, github, health, now: () => state.now,
    assertActive: () => { if (!state.active) throw new Error('leadership lost') },
    authenticate: async (selected, assertWithinBudget) => {
      state.authCalls++
      state.authPolicy = selected
      return options.authenticate ? options.authenticate(selected, assertWithinBudget, state)
        : { token: tokenFor(selected), botId: selected.botId }
    } })
  return { tick: async () => {
    await intake.tick()
    if (fixtureErrors.length) throw fixtureErrors[0]
  }, calls, reads, comments, closed, state, health,
    mutations: () => calls.filter(call => call.method !== 'GET'),
    status: () => health.get('prIntake') }
}

test('intake is opt-in and parses immutable deployment policies', () => {
  assert.deepEqual(parsePrIntake(undefined, ['team/specs']), [])
  assert.deepEqual(parsePrIntake('', ['team/specs']), [])
  assert.deepEqual(parsePrIntake('[]', ['team/specs']), [])
  const parsed = parsePrIntake(JSON.stringify([policy]), ['team/specs'])
  assert.deepEqual(parsed, [policy])
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed[0]))
})

test('invalid, duplicate and unconfigured policies are rejected', () => {
  for (const change of [
    { namespace: 'other/specs' }, { namespace: '../specs' }, { organizationId: 100 },
    { organizationId: '0' }, { organizationId: '01' }, { botId: '-2' }, { botId: '1'.repeat(21) },
    { proposalUrl: 'http://example.org' }, { proposalUrl: 'https://user:password@example.org' },
    { proposalUrl: 'https://example.org/#fragment' }, { proposalUrl: 'https://example.org/\nbody' },
    { proposalUrl: 'https://example.org/a b' }, { proposalUrl: '/relative' }, { extra: true }
  ]) assert.throws(() => parsePrIntake(JSON.stringify([{ ...policy, ...change }]), ['team/specs']), { code: 'pr_intake_config' })
  for (const raw of [' ', '{', '{}', 'null', '[null]', JSON.stringify([policy, { ...policy, namespace: 'TEAM/SPECS' }])]) {
    assert.throws(() => parsePrIntake(raw, ['team/specs']), { code: 'pr_intake_config', message: 'PR_INTAKE is invalid' })
  }
  const unique = Array.from({ length: 21 }, (_, i) => ({ ...policy, namespace: `team/specs-${i}` }))
  const namespaces = unique.map(entry => entry.namespace)
  assert.equal(parsePrIntake(JSON.stringify(unique.slice(0, 20)), namespaces).length, 20)
  assert.throws(() => parsePrIntake(JSON.stringify(unique), namespaces), { code: 'pr_intake_config' })
})

test('disabled intake performs no authentication or requests', async () => {
  const f = fixture({ policies: [], authenticate: () => { throw new Error('must not authenticate') } })
  await f.tick()
  assert.equal(f.status().enabled, false)
  assert.equal(f.calls.length, 0)
})

test('active organization members and the configured bot keep their PRs open', async () => {
  for (const role of ['admin', 'member']) {
    const f = fixture({ membership: membership({ role }) })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, true)
  }
  const f = fixture({ pr: pr => { pr.user = { id: 200, type: 'Bot', login: 'publisher[bot]' } } })
  await f.tick()
  assert.equal(f.mutations().length, 0)
  assert.equal(f.state.memberReads, 0)
})

test('outsiders and pending invitations receive one explanation and are closed', async () => {
  for (const options of [{}, { membership: membership({ state: 'pending' }) },
    { membership: membership({ role: 'billing_manager' }) },
    { pr: pr => { pr.draft = true } }, { pr: pr => { pr.user.id = 200 } },
    { pr: pr => { pr.user = { id: 201, type: 'Bot', login: 'other[bot]' } } },
    { pr: pr => { pr.user.type = 'Mannequin' } }]) {
    const f = fixture(options)
    await f.tick()
    assert.deepEqual(f.mutations().map(call => call.method), ['POST', 'PATCH'])
    assert.ok(f.mutations()[0].body.body.includes(policy.proposalUrl))
    assert.equal(f.closed.size, 1)
    assert.equal(f.status().ok, true)
  }
})

test('invalid or unavailable authentication cannot fall back to another token', async () => {
  for (const authenticate of [async () => { throw new Error('upstream secret') },
    async () => ({ token: '', botId: '200' }), async () => ({ token: tokenFor(policy), botId: '201' })]) {
    const f = fixture({ authenticate })
    await f.tick()
    assert.equal(f.calls.length, 0)
    assert.equal(f.status().ok, false)
    assert.ok(!JSON.stringify(f.status()).includes('secret'))
  }
  for (const status of [401, 403, '403', 200, 700, undefined]) {
    const f = fixture({ authenticate: () => { throw Object.assign(new Error('upstream secret'), { status }) } })
    await f.tick()
    assert.equal(f.status().failures[0].status, Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined)
    assert.equal(f.calls.length, 0)
    assert.ok(!JSON.stringify(f.status()).includes('secret'))
  }
})

test('membership failures and inconsistent identities leave the PR untouched', async () => {
  for (const response of [
    membership({ state: 'unknown' }), membership({ role: 'unknown' }), membership({ user: null }),
    membership({ user: { id: 301, login: 'contributor', type: 'User' } }),
    membership({ user: { id: 300, login: 'other', type: 'User' } }),
    membership({ organization: { id: 101, login: 'team' } }),
    membership({ organization: { id: 100, login: 'other' } }), {}
  ]) {
    const f = fixture({ membership: response })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, false)
  }
  for (const status of [401, 403, 429, 500, '403', 200, 700, undefined]) {
    const f = fixture({ membership: () => { throw Object.assign(new Error('secret'), { status }) } })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, false)
    assert.equal(f.status().failures[0].status, Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined)
    assert.ok(!JSON.stringify(f.status()).includes('secret'))
  }
  for (const response of [null, undefined, false]) {
    const f = fixture({ membership: () => response })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, false)
  }
})

test('PR identity must match the configured repository and organization', async () => {
  for (const pr of [value => { value.number = 2 }, value => { value.base.repo.full_name = 'team/other' },
    value => { value.base.repo.owner.id = 101 }, value => { value.base.repo.owner.type = 'User' },
    value => { value.base.repo.owner.login = 'other' }, value => { value.user.id = '300' },
    value => { value.user.type = 'Other' }, value => { value.user.login = 'name/path' },
    value => { value.state = 'other' }, () => { throw new Error('PR fetch failed') }]) {
    const f = fixture({ pr })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, false)
  }
})

test('membership is checked again immediately before each mutation', async () => {
  for (const becomesMemberAt of [2, 3]) {
    const f = fixture({ membership: count => {
      if (count >= becomesMemberAt) return membership()
      throw absent()
    } })
    await f.tick()
    assert.deepEqual(f.mutations().map(call => call.method), becomesMemberAt === 2 ? [] : ['POST'])
    assert.equal(f.closed.size, 0)
  }
})

test('changed author identity and a PR closed during processing prevent further writes', async () => {
  const changed = fixture({ pr: (pr, count) => { if (count > 1) pr.user.id = 301 } })
  await changed.tick()
  assert.equal(changed.mutations().length, 0)
  assert.equal(changed.status().ok, false)
  const closed = fixture({ pr: (pr, count) => { if (count === 3) pr.state = 'closed' } })
  await closed.tick()
  assert.deepEqual(closed.mutations().map(call => call.method), ['POST'])
  const renamed = fixture({ pr: (pr, count) => { if (count > 1) pr.user.login = 'renamed' },
    memberships: { 'team/renamed': membership({ user: { id: 300, login: 'renamed', type: 'User' } }) } })
  await renamed.tick()
  assert.equal(renamed.mutations().length, 0)
  assert.equal(renamed.status().ok, true)
  assert.deepEqual(renamed.calls.filter(call => call.path.includes('/memberships/')).map(call => call.path),
    ['/orgs/team/memberships/contributor', '/orgs/team/memberships/renamed'])
})

test('leadership is checked immediately before mutations', async () => {
  for (const loseOnRead of [2, 3]) {
    const f = fixture({ membership: (count, state) => {
      if (count === loseOnRead) state.active = false
      throw absent()
    } })
    await f.tick()
    assert.deepEqual(f.mutations().map(call => call.method), loseOnRead === 2 ? [] : ['POST'])
    assert.equal(f.status().ok, false)
  }
  const stopped = fixture()
  stopped.state.active = false
  await stopped.tick()
  assert.equal(stopped.state.authCalls, 0)
  assert.equal(stopped.calls.length, 0)
  assert.equal(stopped.status().ok, false)
})

test('only the configured bot can supply the deduplication marker', async () => {
  for (const user of [{ id: 200, type: 'User' }, { id: 201, type: 'Bot' }]) {
    const f = fixture({ comments: [comment(1, marker, user)] })
    await f.tick()
    assert.deepEqual(f.mutations().map(call => call.method), ['POST', 'PATCH'])
  }
  const f = fixture({ comments: [comment(1, marker, { id: 200, type: 'Bot' })] })
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['PATCH'])
})

test('comment pages establish absence while a trusted marker permits closure immediately', async () => {
  const f = fixture({ comments: [...Array.from({ length: 100 }, (_, n) => comment(n + 1)), comment(101, marker, { id: 200, type: 'Bot' })] })
  await f.tick()
  assert.equal(f.calls.filter(call => call.path.includes('/comments?')).length, 2)
  assert.deepEqual(f.mutations().map(call => call.method), ['PATCH'])
  const alreadyExplained = fixture({ comments: [comment(1, marker, { id: 200, type: 'Bot' }),
    ...Array.from({ length: 1000 }, (_, n) => comment(n + 2))] })
  await alreadyExplained.tick()
  assert.equal(alreadyExplained.calls.filter(call => call.path.includes('/comments?')).length, 1)
  assert.deepEqual(alreadyExplained.mutations().map(call => call.method), ['PATCH'])
  assert.equal(alreadyExplained.status().ok, true)
  for (const commentsPage of [() => Array.from({ length: 100 }, (_, n) => comment(n + 1)),
    () => ({}), () => [{ id: 1 }], () => { throw new Error('upstream secret') }]) {
    const incomplete = fixture({ commentsPage })
    await incomplete.tick()
    assert.equal(incomplete.mutations().length, 0)
    assert.equal(incomplete.status().ok, false)
  }
})

test('a lost comment response is recovered without a second explanation', async () => {
  const f = fixture({ failPost: true })
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['POST'])
  assert.equal(f.status().ok, false)
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['POST', 'PATCH'])
  assert.equal(f.status().ok, true)
})

test('a lost closure response does not repeat the comment or reopen the PR', async () => {
  const f = fixture({ failClose: true })
  await f.tick()
  assert.equal(f.status().ok, false)
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['POST', 'PATCH'])
  assert.equal(f.status().ok, true)
})

test('bounded pages eventually examine later PRs without repeating allowed PRs each tick', async () => {
  const f = fixture({ numbers: Array.from({ length: 55 }, (_, n) => n + 1), membership: membership() })
  for (let tick = 0; tick < 11; tick++) await f.tick()
  assert.equal(f.reads.size, 55)
  assert.ok([...f.reads.values()].every(count => count === 1))
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 2)
})

test('page shifts caused by closures are recovered by the next sweep', async () => {
  const f = fixture({ numbers: Array.from({ length: 55 }, (_, n) => n + 1) })
  for (let tick = 0; tick < 12; tick++) await f.tick()
  assert.equal(f.closed.size, 55)
  assert.equal(f.mutations().filter(call => call.method === 'POST').length, 55)
})

test('a failing candidate does not starve the rest of its page', async () => {
  const f = fixture({ numbers: [1, 2, 3, 4, 5, 6], pr: pr => { if (pr.number === 1) pr.user.id = null } })
  await f.tick()
  assert.equal(f.closed.size, 4)
  await f.tick()
  assert.equal(f.closed.size, 5)
  assert.equal(f.status().ok, false)
})

test('policies are served fairly and another namespace cannot clear a failure', async () => {
  const f = fixture({ policies: [policy, { ...policy, namespace: 'other/specs', organizationId: '101', botId: '201' }],
    pr: pr => { pr.user = { id: 200, type: 'Bot', login: 'first-policy[bot]' } },
    authenticate: selected => {
      if (selected.namespace === policy.namespace) throw new Error('secret')
      return { token: tokenFor(selected), botId: selected.botId }
    } })
  await f.tick()
  await f.tick()
  assert.ok(f.closed.has('other/specs#1'))
  assert.equal(f.status().ok, false)
  assert.deepEqual(f.status().failures, [{ namespace: 'team/specs', code: 'pr_intake_request' }])
})

test('invalid PR listings cause no mutations', async () => {
  for (const list of [() => null, () => [{ number: 0 }], () => [{ number: 1 }, { number: 1 }],
    () => Array.from({ length: 51 }, (_, n) => ({ number: n + 1 }))]) {
    const f = fixture({ list })
    await f.tick()
    assert.equal(f.mutations().length, 0)
    assert.equal(f.status().ok, false)
  }
})

test('the discovery bound is reported and the next sweep starts at page one', async () => {
  const f = fixture({ list: page => Array.from({ length: 50 }, (_, n) => ({ number: (page - 1) * 50 + n + 1 })),
    pr: pr => { pr.user = { id: 200, type: 'Bot', login: 'publisher[bot]' } } })
  for (let tick = 0; tick < 2000; tick++) await f.tick()
  assert.equal(f.status().error, 'pr_intake_page_limit')
  await f.tick()
  assert.ok(f.calls.filter(call => call.path.includes('/pulls?')).at(-1).path.endsWith('&page=1'))
  assert.equal(f.status().ok, false)
})

test('authentication receives the tick deadline and cannot spend another request after it', async () => {
  let authenticatedCalls = 0
  const f = fixture({ authenticate: async (_policy, assertWithinBudget, state) => {
    assertWithinBudget()
    authenticatedCalls++
    state.now += 30000
    assertWithinBudget()
    authenticatedCalls++
    return { token: tokenFor(policy), botId: '200' }
  } })
  await f.tick()
  assert.equal(authenticatedCalls, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.status().error, 'pr_intake_budget')
  assert.deepEqual(f.status().deferred, ['team/specs'])
})

test('a slow read defers the candidate while preserving the rest of its discovery page', async () => {
  let slow = true
  const f = fixture({ numbers: [1, 2], onRequest: ({ path, state }) => {
    if (slow && path.endsWith('/pulls/1')) { state.now += 30000; slow = false }
  } })
  await f.tick()
  assert.equal(f.state.memberReads, 0)
  assert.equal(f.mutations().length, 0)
  assert.equal(f.status().pending, 1)
  assert.equal(f.status().error, 'pr_intake_budget')
  await f.tick()
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 1)
  assert.deepEqual([...f.closed], ['team/specs#2'])
  await f.tick()
  assert.equal(f.closed.size, 2)
  assert.equal(f.reads.get('team/specs#1'), 4)
})

test('late membership responses cannot authorize a comment or closure beyond the deadline', async () => {
  for (const expireOnRead of [2, 3]) {
    const f = fixture({ membership: (count, state) => {
      if (count === expireOnRead) state.now += 30000
      throw absent()
    } })
    await f.tick()
    assert.deepEqual(f.mutations().map(call => call.method), expireOnRead === 2 ? [] : ['POST'])
    assert.equal(f.closed.size, 0)
    assert.equal(f.status().pending, 0)
    assert.equal(f.status().error, 'pr_intake_budget')
  }
})

test('a posted comment is reused when the deadline defers closure', async () => {
  const f = fixture({ onRequest: ({ method, state }) => { if (method === 'POST') state.now += 30000 } })
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['POST'])
  assert.equal(f.status().pending, 0)
  await f.tick()
  assert.deepEqual(f.mutations().map(call => call.method), ['POST', 'PATCH'])
  assert.equal(f.closed.size, 1)
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 2)
})

test('budget deferrals let other candidates progress and retry on the next sweep', async () => {
  let slow = true
  const f = fixture({ numbers: [1, 2, 3, 4, 5, 6], onRequest: ({ path, state }) => {
    if (slow && path.endsWith('/pulls/1')) { state.now += 30000; slow = false }
  } })
  await f.tick()
  assert.equal(f.status().pending, 5)
  await f.tick()
  assert.deepEqual([...f.closed], ['team/specs#2', 'team/specs#3', 'team/specs#4', 'team/specs#5', 'team/specs#6'])
  assert.equal(f.reads.get('team/specs#1'), 1)
  assert.equal(f.status().pending, 0)
  await f.tick()
  assert.equal(f.closed.size, 6)
  assert.equal(f.status().pending, 0)
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 2)
})

test('listing deadlines defer work and distinguish API errors from deferrals', async () => {
  const f = fixture({ onRequest: ({ path, state }) => {
    if (path.includes('/pulls?')) state.now += 30000
  } })
  await f.tick()
  assert.equal(f.reads.size, 0)
  assert.equal(f.status().pending, 1)
  assert.equal(f.status().error, 'pr_intake_budget')
  await f.tick()
  assert.equal(f.closed.size, 1)
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 1)
  const unavailable = fixture({ onRequest: () => { throw new Error('upstream secret') } })
  await unavailable.tick()
  assert.equal(unavailable.status().error, 'pr_intake_request')
  assert.deepEqual(unavailable.status().deferred, [])
})

test('a deadline does not clear or replace an unresolved repository error', async () => {
  const f = fixture({ authenticate: (_policy, assertWithinBudget, state) => {
    if (!state.now) { state.now = 1; throw Object.assign(new Error('upstream secret'), { code: 'intake.permissions', status: 403 }) }
    state.now += 30000
    assertWithinBudget()
  } })
  await f.tick()
  assert.equal(f.status().error, 'intake.permissions')
  assert.equal(f.status().failures[0].status, 403)
  f.state.now = f.status().failures[0].retryAt
  await f.tick()
  assert.equal(f.status().error, 'intake.permissions')
  assert.equal(f.status().failures[0].status, 403)
  assert.deepEqual(f.status().deferred, ['team/specs'])
  const exhausted = fixture({ membership: (count, state) => {
    if (count === 1) throw Object.assign(new Error('upstream secret'), { status: 403 })
    state.now += 30000
    throw absent()
  } })
  await exhausted.tick()
  exhausted.state.now = exhausted.status().failures[0].retryAt
  await exhausted.tick()
  assert.deepEqual(exhausted.status().failures, [{ namespace: 'team/specs', code: 'pr_intake_request', status: 403, retryAt: 60000 }])
  assert.deepEqual(exhausted.status().deferred, ['team/specs'])
})

test('repeated budget exhaustion on an early PR cannot pin discovery to its page', async () => {
  const f = fixture({ numbers: Array.from({ length: 55 }, (_, n) => n + 1), membership: membership(),
    onRequest: ({ path, state }) => { if (path.endsWith('/pulls/1')) state.now += 30000 } })
  for (let tick = 0; tick < 12; tick++) await f.tick()
  assert.equal(f.reads.size, 55)
  assert.equal(f.reads.get('team/specs#55'), 1)
  assert.equal(f.status().error, 'pr_intake_budget')
  assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 2)
  await f.tick()
  assert.equal(f.reads.get('team/specs#1'), 2)
  assert.ok(f.calls.filter(call => call.path.includes('/pulls?')).at(-1).path.endsWith('&page=1'))
  assert.equal(f.status().ok, false)
})

test('authentication backoff prevents fresh tokens while other namespaces continue', async () => {
  for (const failure of [{ status: 429, retryAt: 300000 }, { code: 'intake.bot' },
    { code: 'intake.permissions', status: 403, retryAt: 900000 }]) {
    let attempts = 0
    const delay = failure.retryAt || 300000
    const f = fixture({ policies: [policy, { ...policy, namespace: 'other/specs', organizationId: '101', botId: '201' }],
      authenticate: selected => {
        if (selected.namespace === policy.namespace && ++attempts === 1) throw Object.assign(new Error('upstream secret'), failure)
        return { token: tokenFor(selected), botId: selected.botId }
      } })
    await f.tick()
    assert.equal(f.calls.length, 0)
    assert.equal(f.status().failures[0].retryAt, delay)
    await f.tick()
    assert.ok(f.closed.has('other/specs#1'))
    const authCalls = f.state.authCalls, requests = f.calls.length
    await f.tick()
    assert.equal(attempts, 1)
    assert.equal(f.state.authCalls, authCalls)
    assert.equal(f.calls.length, requests)
    assert.equal(f.status().ok, false)
    f.state.now = delay - 1
    await f.tick()
    await f.tick()
    assert.equal(attempts, 1)
    f.state.now = delay
    await f.tick()
    await f.tick()
    assert.equal(attempts, 2)
    assert.ok(f.closed.has('team/specs#1'))
    assert.ok(!JSON.stringify(f.status()).includes('secret'))
  }
})

test('rate-limit reset times are bounded and invalid values use the default delay', async () => {
  const start = 1794090000000
  for (const [retryAt, delay] of [[undefined, 60000], [Infinity, 60000], [NaN, 60000],
    ['1794090900000', 60000], [-1, 60000], [start - 1, 60000], [start + 90000.5, 60000],
    [Number.MAX_SAFE_INTEGER + 1, 60000], [start + 1000, 60000], [start + 900000, 900000],
    [start + 172800000, 86400000]]) {
    const f = fixture({ authenticate: () => { throw Object.assign(new Error('upstream secret'), { status: 403, retryAt }) } })
    f.state.now = start
    await f.tick()
    assert.deepEqual(f.status().failures, [{ namespace: policy.namespace, code: 'pr_intake_request', status: 403, retryAt: start + delay }])
    f.state.now = start + delay - 1
    await f.tick()
    assert.equal(f.state.authCalls, 1)
    assert.equal(f.calls.length, 0)
    assert.ok(!JSON.stringify(f.status()).includes('secret'))
  }
})

test('request rate limits preserve the remaining queue without reminting before reset', async () => {
  let limited = true
  const f = fixture({ numbers: [1, 2], onRequest: ({ path }) => {
    if (limited && path.endsWith('/pulls/1')) {
      limited = false
      throw Object.assign(new Error('upstream secret'), { status: 429, retryAt: 900000 })
    }
  } })
  await f.tick()
  assert.equal(f.status().pending, 1)
  assert.equal(f.status().failures[0].retryAt, 900000)
  assert.equal(f.mutations().length, 0)
  const requests = f.calls.length
  await f.tick()
  assert.equal(f.state.authCalls, 1)
  assert.equal(f.calls.length, requests)
  f.state.now = 900000
  await f.tick()
  assert.ok(f.closed.has('team/specs#2'))
  await f.tick()
  assert.ok(f.closed.has('team/specs#1'))
})

test('expired deadlines or leadership preserve the next unread candidate', async () => {
  for (const expires of ['deadline', 'leadership']) {
    const f = fixture({ numbers: [1, 2], onRequest: ({ method, path, state }) => {
      if (method === 'PATCH' && path.endsWith('/pulls/1')) {
        if (expires === 'deadline') state.now += 30000
        else state.active = false
      }
    } })
    await f.tick()
    assert.deepEqual([...f.closed], ['team/specs#1'])
    assert.equal(f.reads.has('team/specs#2'), false)
    assert.equal(f.status().pending, 1)
    f.state.active = true
    await f.tick()
    assert.ok(f.closed.has('team/specs#2'))
    assert.equal(f.calls.filter(call => call.path.includes('/pulls?')).length, 1)
  }
})
