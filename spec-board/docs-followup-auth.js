const numericId = value => Number.isSafeInteger(value) && value > 0
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const failure = suffix => Object.assign(new Error('Documentation GitHub App authentication could not be verified.'), { code: 'docs-auth-' + suffix })

function createDocumentationAuth ({ github, jwt, appId, enabled, signal, now = Date.now }) {
  let app = null
  const tokens = new Map()
  const assertion = () => {
    const token = jwt()
    if (typeof token !== 'string' || !token) throw failure('credentials')
    return token
  }
  const request = async (method, path, body, token) => {
    signal?.throwIfAborted()
    if (typeof token !== 'string' || !token) throw failure('credentials')
    try { return await github(method, path, body, token, { signal }) } catch (error) {
      const out = failure('unavailable')
      if ([401, 403, 404, 429].includes(error.status)) out.status = error.status
      if (Number.isSafeInteger(error.retryAt) && error.retryAt > now()) out.retryAt = Math.min(error.retryAt, now() + 86400000)
      throw out
    }
  }

  return async function authenticate (repo, requested) {
    signal?.throwIfAborted()
    if (!enabled) throw failure('credentials')
    if (typeof appId !== 'string' || !/^[A-Za-z0-9.]{1,100}$/.test(appId)) throw failure('identity')
    if (typeof repo !== 'string' || repo.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) throw failure('repository')
    if (!requested || typeof requested !== 'object' || Array.isArray(requested) || Object.entries(requested).some(([key, value]) =>
      !['contents', 'pull_requests', 'issues', 'metadata'].includes(key) || !['read', 'write'].includes(value) || (key === 'metadata' && value !== 'read'))) throw failure('permissions')
    const permissions = Object.fromEntries(Object.entries({ ...requested, metadata: 'read' }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    if (!app) {
      const identity = await request('GET', '/app', null, assertion())
      if (!numericId(identity?.id) || (String(identity.id) !== appId && identity.client_id !== appId) ||
          typeof identity.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.slug)) throw failure('identity')
      app = { id: identity.id, slug: identity.slug }
    }
    const key = repo.toLowerCase() + ':' + JSON.stringify(permissions)
    const cached = tokens.get(key)
    if (cached && cached.until > now()) return cached.auth
    const [owner, name] = repo.split('/')
    const installation = await request('GET', `/repos/${repo}/installation`, null, assertion())
    if (!numericId(installation?.id) || installation.app_id !== app.id || installation.suspended_at !== null ||
        !numericId(installation.account?.id) || !['User', 'Organization'].includes(installation.account.type) ||
        !same(installation.account.login, owner)) throw failure('installation')
    for (const [permission, level] of Object.entries(permissions)) {
      if (permission === 'metadata') continue
      const granted = installation.permissions?.[permission]
      if (granted !== level && !(level === 'read' && granted === 'write')) throw failure('installation-permissions')
    }
    const grant = await request('POST', `/app/installations/${installation.id}/access_tokens`, {
      repositories: [name], permissions
    }, assertion())
    if (!grant?.permissions || Object.keys(grant.permissions).length !== Object.keys(permissions).length ||
        Object.entries(permissions).some(([key, value]) => grant.permissions[key] !== value)) throw failure('token-permissions')
    const repos = grant.repositories
    if (!Array.isArray(repos) || repos.length !== 1 || !numericId(repos[0]?.id) || !same(repos[0].full_name, repo) ||
        !numericId(repos[0].owner?.id) || repos[0].owner.id !== installation.account.id ||
        repos[0].owner.type !== installation.account.type || !same(repos[0].owner.login, owner)) throw failure('token-repositories')
    const expires = Date.parse(grant.expires_at)
    if (typeof grant.token !== 'string' || !grant.token || !Number.isFinite(expires) || expires <= now() + 60000) throw failure('expiry')
    const login = `${app.slug}[bot]`
    const bot = await request('GET', `/users/${encodeURIComponent(login)}`, null, grant.token)
    if (!numericId(bot?.id) || bot.type !== 'Bot' || !same(bot.login, login)) throw failure('bot-identity')
    const auth = { token: grant.token, botId: bot.id, botLogin: bot.login }
    tokens.set(key, { auth, until: Math.min(expires - 60000, now() + 300000) })
    return auth
  }
}

module.exports = { createDocumentationAuth }
