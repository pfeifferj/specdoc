const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Pool } = require('pg')
process.env.SESSION_SECRET = 'oauth-test-secret'
process.env.BOARD_OAUTH_CLIENT_ID = 'test-client'
process.env.BOARD_OAUTH_CLIENT_SECRET = 'test-secret'
delete process.env.SMTP_HOST
const file = path.join(__dirname, 'server.js')
const mod = new Module(file + '.github-oauth-test', module)
mod.filename = file
mod.paths = Module._nodeModulePaths(__dirname)
mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.finishLogin = finishLogin\n', file)
const { finishLogin, signToken, verifyToken, profileEmail } = mod.exports
const profile = { provider: 'github', id: '42', username: 'reviewer', displayName: 'Reviewer Name', emails: [] }
const account = { id: 'account', profile: JSON.stringify(profile) }
let linked = true, emailFailure = false
const updates = []
const addresses = [
  { email: 'secondary@example.test', verified: true, primary: false },
  { email: 'unverified@example.test', verified: false, primary: false },
  { email: 'private-primary@example.test', verified: true, primary: true }
]

async function login () {
  const req = { headers: { host: 'board.test', cookie: `sb_oauth=${signToken({ st: 'state', next: '/settings', exp: Date.now() + 60000 })}` } }
  const res = {
    headers: {}, getHeader (name) { return this.headers[name] },
    setHeader (name, value) { this.headers[name] = value },
    writeHead (status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this },
    end (body) { this.body = body; return this }
  }
  await finishLogin(req, res, new URL('https://board.test/auth/github/callback?code=code&state=state'))
  return res
}

async function main () {
  const oldQuery = Pool.prototype.query
  const oldFetch = global.fetch
  Pool.prototype.query = async function (sql, args) {
    if (sql.startsWith('SELECT id, profile')) return { rows: linked ? [account] : [] }
    if (sql.startsWith('UPDATE "Users"')) {
      assert.equal(args[0], account.id)
      assert.match(sql, /jsonb_set/)
      assert.match(sql, /provider.*github/)
      assert.match(sql, /profile::jsonb->>'id'/)
      assert.equal(args[2], '42')
      updates.push(JSON.parse(args[1]))
      return { rows: [{ id: account.id }] }
    }
    throw new Error('Unexpected query: ' + sql)
  }
  global.fetch = async url => {
    if (url === 'https://github.com/login/oauth/access_token') return { ok: true, json: async () => ({ access_token: 'test-token' }) }
    if (url === 'https://api.github.com/user') return { ok: true, json: async () => ({ id: 42, login: 'reviewer' }) }
    if (url === 'https://api.github.com/user/emails') return { ok: !emailFailure, status: emailFailure ? 403 : 200, json: async () => emailFailure ? { message: 'permission denied' } : addresses }
    throw new Error('Unexpected fetch: ' + url)
  }
  try {
    const res = await login()
    assert.equal(res.status, 302)
    assert.deepEqual(updates, [[
      { value: 'private-primary@example.test', primary: true, verified: true },
      { value: 'secondary@example.test', primary: false, verified: true }
    ]], 'verified addresses must reach the linked account, not just the session cookie')
    assert.equal(profileEmail(JSON.stringify({ ...profile, emails: updates[0] })), 'private-primary@example.test')
    const cookie = res.headers['Set-Cookie'].find(c => c.startsWith('sb_session='))
    const session = verifyToken(cookie.slice('sb_session='.length).split(';')[0])
    assert.deepEqual(session.emails, ['private-primary@example.test', 'secondary@example.test'])
    assert.equal(session.uid, 'account')
    emailFailure = true
    await login()
    assert.equal(updates.length, 1, 'an email lookup failure must preserve saved account emails')
    emailFailure = false
    linked = false
    await login()
    assert.equal(updates.length, 1, 'an unlinked GitHub account must not update another account')
    console.log('GitHub OAuth: verified primary-first email persistence and failed lookup preservation passed')
  } finally {
    Pool.prototype.query = oldQuery
    global.fetch = oldFetch
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
