const permissions = Object.freeze({ members: 'read', pull_requests: 'write', metadata: 'read' })
const numericId = value => Number.isSafeInteger(value) && value > 0
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()

function failure (code) {
  return Object.assign(new Error('PR intake authentication could not be verified'), { code: `intake.${code}` })
}

function createPrIntakeAuth ({ github, jwt, appId, enabled, now = Date.now }) {
  const tokens = new Map()
  let identity = null

  async function appIdentity (request) {
    if (identity && now() < identity.until) return identity
    const assertion = jwt()
    if (typeof assertion !== 'string' || !assertion) throw failure('credentials')
    const app = await request('GET', '/app', null, assertion)
    if (!numericId(app?.id) || (String(app.id) !== String(appId) && app.client_id !== appId) ||
        typeof app.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.slug)) throw failure('app_identity')
    identity = { appId: app.id, slug: app.slug, until: now() + 300000 }
    return identity
  }

  return async function authenticate (policy, assertActive = () => {}) {
    const request = (...args) => { assertActive(); return github(...args) }
    assertActive()
    if (!enabled) throw failure('credentials')
    if (typeof appId !== 'string' || !/^[A-Za-z0-9.]{1,100}$/.test(appId)) throw failure('app_identity')
    const app = await appIdentity(request)
    const key = `${policy.namespace}:${policy.organizationId}:${policy.botId}`
    const cached = tokens.get(key)
    if (cached && now() < cached.until) return { token: cached.token, botId: policy.botId }

    const [owner, repository] = policy.namespace.split('/')
    const assertion = jwt()
    if (typeof assertion !== 'string' || !assertion) throw failure('credentials')
    const installation = await request('GET', `/repos/${policy.namespace}/installation`, null, assertion)
    if (!numericId(installation?.id) || installation.app_id !== app.appId || installation.suspended_at !== null ||
        installation.account?.type !== 'Organization' || !numericId(installation.account.id) ||
        String(installation.account.id) !== policy.organizationId || !same(installation.account.login, owner)) {
      throw failure('installation_identity')
    }
    if (!['read', 'write'].includes(installation.permissions?.members) || installation.permissions?.pull_requests !== 'write') {
      throw failure('installation_permissions')
    }
    const grant = await request('POST', `/app/installations/${installation.id}/access_tokens`, {
      repositories: [repository], permissions
    }, assertion)
    if (!grant?.permissions || Object.keys(grant.permissions).length !== Object.keys(permissions).length ||
        Object.entries(permissions).some(([name, value]) => grant.permissions[name] !== value)) throw failure('token_permissions')
    const repos = grant.repositories
    if (!Array.isArray(repos) || repos.length !== 1 || !numericId(repos[0]?.id) || !same(repos[0].full_name, policy.namespace) ||
        repos[0].owner?.type !== 'Organization' || !numericId(repos[0].owner.id) || String(repos[0].owner.id) !== policy.organizationId ||
        !same(repos[0].owner?.login, owner)) throw failure('token_repositories')
    const expires = Date.parse(grant.expires_at)
    if (typeof grant.token !== 'string' || !grant.token || !Number.isFinite(expires) || expires <= now() + 60000) throw failure('token_expiry')
    const bot = await request('GET', `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, null, grant.token)
    if (bot?.type !== 'Bot' || !numericId(bot.id) || String(bot.id) !== policy.botId ||
        !same(bot.login, `${app.slug}[bot]`)) throw failure('bot_identity')
    tokens.set(key, { token: grant.token, until: Math.min(expires - 60000, now() + 300000) })
    return { token: grant.token, botId: policy.botId }
  }
}

module.exports = { createPrIntakeAuth }
