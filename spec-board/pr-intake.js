'use strict'

const MARKER = '<!-- specdoc-pr-intake -->'
const PAGE_SIZE = 50
const MAX_PAGES = 200
const PER_TICK = 5
const ABSENT = Symbol('absent')
const positive = value => Number.isSafeInteger(value) && value > 0
const identity = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
const fail = code => Object.assign(new Error(code === 'config' ? 'PR_INTAKE is invalid' : 'Pull request intake could not verify the request'), { code: `pr_intake_${code}` })
const httpFailure = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
  ? { status: error.status, ...([403, 429].includes(error.status) && Number.isSafeInteger(error.retryAt) && error.retryAt > 0 ? { retryAt: error.retryAt } : {}) } : {}

function parsePrIntake (raw, namespaces) {
  if (raw === undefined || raw === '') return Object.freeze([])
  let entries
  try { entries = JSON.parse(raw) } catch { throw fail('config') }
  if (!Array.isArray(entries) || entries.length > 20) throw fail('config')
  const known = new Set(namespaces.map(value => value.toLowerCase()))
  const seen = new Set()
  return Object.freeze(entries.map(entry => {
    if (!object(entry) || Object.keys(entry).length !== 4 ||
        Object.keys(entry).some(key => !['namespace', 'organizationId', 'botId', 'proposalUrl'].includes(key)) ||
        typeof entry.namespace !== 'string' || entry.namespace.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(entry.namespace) ||
        ['.', '..'].includes(entry.namespace.split('/')[1]) ||
        !known.has(entry.namespace.toLowerCase()) || seen.has(entry.namespace.toLowerCase()) ||
        !identity(entry.organizationId) || !identity(entry.botId) || typeof entry.proposalUrl !== 'string' ||
        /[\x00-\x20\x7f]/.test(entry.proposalUrl)) throw fail('config')
    let url
    try { url = new URL(entry.proposalUrl) } catch { throw fail('config') }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw fail('config')
    seen.add(entry.namespace.toLowerCase())
    return Object.freeze({ ...entry, proposalUrl: url.href })
  }))
}

function createPrIntake ({ policies, github, authenticate, assertActive, health, now = Date.now }) {
  const states = policies.map(policy => ({ policy, page: 1, queue: [], lastPage: false, sweepError: null, error: null, deferred: false }))
  let next = 0
  let running = false
  let deadline = Infinity
  const details = () => ({ enabled: states.length > 0, repositories: states.length,
    pending: states.reduce((count, state) => count + state.queue.length, 0),
    deferred: states.filter(state => state.deferred).map(state => state.policy.namespace),
    failures: states.filter(state => state.error).map(state => ({ namespace: state.policy.namespace, ...state.error })) })
  health.observe('prIntake', details())

  function assertWithinBudget () {
    assertActive()
    if (now() >= deadline) throw fail('budget')
  }

  async function request (method, path, body, token, allowAbsent = false) {
    assertWithinBudget()
    try { return await github(method, path, body, token) } catch (error) {
      if (error?.code === 'pr_intake_budget') throw error
      if (allowAbsent && error?.status === 404) return ABSENT
      throw Object.assign(fail('request'), httpFailure(error))
    }
  }

  async function externalPr (policy, number, token, author) {
    const pr = await request('GET', `/repos/${policy.namespace}/pulls/${number}`, null, token)
    const owner = policy.namespace.split('/')[0]
    const account = pr?.base?.repo?.owner
    if (!object(pr) || pr.number !== number || !['open', 'closed'].includes(pr.state) ||
        !same(pr.base?.repo?.full_name, policy.namespace) || account?.type !== 'Organization' ||
        !positive(account.id) || String(account.id) !== policy.organizationId || !same(account.login, owner) ||
        !positive(pr.user?.id) || typeof pr.user.login !== 'string' ||
        !/^[\w-]{1,100}(?:\[bot\])?$/.test(pr.user.login) || !['User', 'Bot', 'Mannequin'].includes(pr.user.type)) throw fail('identity')
    if (author && (pr.user.id !== author.id || pr.user.type !== author.type)) throw fail('identity')
    if (pr.state !== 'open' || pr.merged_at) return null
    if (pr.user.type === 'Bot' && String(pr.user.id) === policy.botId) return null
    if (pr.user.type === 'User') {
      const membership = await request('GET', `/orgs/${owner}/memberships/${encodeURIComponent(pr.user.login)}`, null, token, true)
      if (membership !== ABSENT) {
        if (!object(membership) || !['active', 'pending'].includes(membership.state) ||
            !['admin', 'member', 'billing_manager'].includes(membership.role) || membership.user?.type !== 'User' ||
            membership.user.id !== pr.user.id || !same(membership.user.login, pr.user.login) ||
            !positive(membership.organization?.id) || String(membership.organization.id) !== policy.organizationId ||
            !same(membership.organization.login, owner)) throw fail('membership')
        if (membership.state === 'active' && ['admin', 'member'].includes(membership.role)) return null
      }
    }
    return pr
  }

  async function explained (policy, number, token) {
    for (let page = 1; page <= 10; page++) {
      const comments = await request('GET', `/repos/${policy.namespace}/issues/${number}/comments?per_page=100&page=${page}`, null, token)
      if (!Array.isArray(comments) || comments.length > 100 || comments.some(comment => !object(comment) ||
          !positive(comment.id) || typeof comment.body !== 'string')) throw fail('comments')
      if (comments.some(comment => comment.user?.type === 'Bot' && positive(comment.user.id) &&
        String(comment.user.id) === policy.botId && comment.body.includes(MARKER))) return true
      if (comments.length < 100) return false
    }
    throw fail('comment_limit')
  }

  async function processPr (policy, number, token) {
    const initial = await externalPr(policy, number, token)
    if (!initial) return
    if (!await explained(policy, number, token)) {
      if (!await externalPr(policy, number, token, initial.user)) return
      const proposal = policy.proposalUrl.replace(/[<>]/g, value => value === '<' ? '%3C' : '%3E')
      await request('POST', `/repos/${policy.namespace}/issues/${number}/comments`, {
        body: `${MARKER}\n\nSpecification changes are reviewed in [SpecDoc](<${proposal}>). Please submit your proposal there; outside pull requests are closed here. After approval, SpecDoc opens the publication pull request.`
      }, token)
    }
    if (!await externalPr(policy, number, token, initial.user)) return
    await request('PATCH', `/repos/${policy.namespace}/pulls/${number}`, { state: 'closed' }, token)
  }

  function recordError (state, error) {
    const code = typeof error?.code === 'string' && /^(?:pr_intake_[a-z_]+|intake\.[a-z_]+)$/.test(error.code) ? error.code : 'pr_intake_request'
    const failure = { code, ...httpFailure(error) }
    const time = now()
    if ([403, 429].includes(failure.status)) {
      failure.retryAt = Math.min(time + 86400000, Math.max(time + 60000, failure.retryAt || 0))
    }
    if (code.startsWith('intake.')) failure.retryAt = Math.max(failure.retryAt || 0, time + 300000)
    if (code === 'pr_intake_budget') {
      state.deferred = true
      state.sweepError ||= state.error || failure
      state.error ||= failure
    } else {
      state.sweepError = failure
      state.error = failure
    }
  }

  function finishPage (state) {
    if (state.lastPage || state.page === MAX_PAGES) {
      if (!state.lastPage) recordError(state, fail('page_limit'))
      state.error = state.sweepError
      state.sweepError = null
      state.page = 1
    } else state.page++
  }

  async function tick () {
    if (!states.length || running) return
    running = true
    deadline = now() + 30000
    const state = states[next]
    state.deferred = false
    next = (next + 1) % states.length
    try {
      assertWithinBudget()
      if (state.error?.retryAt > now()) return
      const auth = await authenticate(state.policy, assertWithinBudget)
      if (!auth || typeof auth.token !== 'string' || !auth.token || auth.botId !== state.policy.botId) throw fail('auth')
      if (!state.queue.length) {
        const pulls = await request('GET', `/repos/${state.policy.namespace}/pulls?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${state.page}`, null, auth.token)
        if (!Array.isArray(pulls) || pulls.length > PAGE_SIZE || pulls.some(pr => !positive(pr?.number)) ||
            new Set(pulls.map(pr => pr.number)).size !== pulls.length) throw fail('listing')
        state.queue = pulls.map(pr => pr.number)
        state.lastPage = pulls.length < PAGE_SIZE
      }
      for (let count = 0; count < PER_TICK && state.queue.length; count++) {
        assertWithinBudget()
        const number = state.queue.shift()
        try { await processPr(state.policy, number, auth.token) } catch (error) {
          recordError(state, error)
          if (error?.code === 'pr_intake_budget' || [403, 429].includes(error?.status)) break
        }
      }
      if (!state.queue.length) finishPage(state)
    } catch (error) {
      recordError(state, error)
    } finally {
      running = false
      deadline = Infinity
      const status = details()
      if (status.failures.length) health.failure('prIntake', status.failures[0].code, status)
      else health.success('prIntake', status)
    }
  }

  return { tick }
}

module.exports = { parsePrIntake, createPrIntake }
