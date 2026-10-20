'use strict'

// This fixture always uses its own in-memory database, never application configuration.
process.env.NODE_ENV = 'test'
process.env.CMD_DB_URL = 'sqlite::memory:'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '..')
const editor = path.resolve(process.env.SPECDOC_TEST_EDITOR_DIR || path.join(root, 'editor/.work'))
const fromEditor = createRequire(path.join(editor, 'package.json'))
const express = fromEditor('express')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-cli-editor-'))
const binary = path.join(root, 'cli/bin/specdoc.js')
let server
let models
const children = new Set()

function cli (args, env, onStderr) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], { cwd: temporary, env, stdio: 'pipe' })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdin.end()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (onStderr) onStderr(stderr)
    })
    child.on('error', reject)
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI fixture timed out')) }, 30000)
    child.on('close', code => { children.delete(child); clearTimeout(timeout); resolve({ code, stdout, stderr }) })
  })
}

function successful (result) {
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout).data
}

async function main () {
  const app = express()
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  process.env.CMD_DOMAIN = '127.0.0.1'
  process.env.CMD_PORT = String(server.address().port)
  process.env.CMD_URL_ADDPORT = 'true'
  process.env.CMD_PROTOCOL_USESSL = 'false'
  process.env.CMD_URL_PATH = ''
  process.env.CMD_SESSION_SECRET = crypto.randomBytes(32).toString('hex')
  const config = fromEditor('./lib/config')
  models = fromEditor('./lib/models')
  const { publicRouter, browserRouter } = fromEditor('./lib/web/cliAuthRouter')
  const apiRouter = fromEditor('./lib/web/apiRouter')
  assert.equal(models.sequelize.getDialect(), 'sqlite')
  assert.equal(config.dbURL, 'sqlite::memory:')
  assert.equal(config.serverURL, origin)
  await models.sequelize.sync({ force: true })
  fromEditor('./lib/realtime').maintenance = false
  fromEditor('./lib/history').updateHistory = () => {}
  const user = await models.User.create({})
  const session = { passport: { user: user.id } }
  let dropUpdate = true
  let droppedUpdates = 0
  app.set('views', path.join(editor, 'public/views'))
  app.set('view engine', 'ejs')
  // app.set resolves engines relative to this test runner unless explicitly registered.
  app.engine('ejs', fromEditor('ejs').__express)
  app.use((req, res, next) => {
    if (req.method === 'PUT' && req.path.startsWith('/api/v1/notes/') && dropUpdate) {
      const end = res.end
      res.end = function (...args) {
        if (res.statusCode === 200 && dropUpdate) {
          dropUpdate = false
          droppedUpdates++
          req.socket.destroy()
          return res
        }
        return end.apply(this, args)
      }
    }
    next()
  })
  app.use(publicRouter)
  app.use(apiRouter)
  app.use((req, res, next) => {
    if (req.get('x-fixture-browser') === user.id) {
      req.user = user
      req.session = session
      req.isAuthenticated = () => true
    }
    next()
  })
  app.use(browserRouter)
  const env = {
    ...process.env,
    SPECDOC_TOKEN: '', SPECDOC_BOT_TOKEN: '', SPECDOC_URL: '', SPECDOC_BOARD_URL: '',
    SPECDOC_CONFIG_DIR: path.join(temporary, 'config'), SPECDOC_EDITOR_URL: origin, SPECDOC_PROFILE: 'default'
  }
  let approve
  const approval = new Promise((resolve, reject) => { approve = { resolve, reject } })
  let started = false
  const login = cli(['auth', 'login', '--storage', 'file', '--format', 'json'], env, stderr => {
    const found = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/cli\/authorize\?user_code=[A-Z0-9-]+/)
    if (!found || started) return
    started = true
    ;(async () => {
      const page = await fetch(found[0], { headers: { 'x-fixture-browser': user.id } })
      assert.equal(page.status, 200)
      const html = await page.text()
      const csrf = /name="_csrf" value="([a-f0-9]+)"/.exec(html)
      assert.ok(csrf, 'Consent page must contain its session-bound CSRF nonce')
      assert.ok(html.includes('notes:write') || html.includes('write'), 'Consent must disclose write access')
      const code = new URL(found[0]).searchParams.get('user_code')
      const response = await fetch(origin + '/cli/authorize', {
        method: 'POST',
        headers: { 'x-fixture-browser': user.id, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf[1], user_code: code, decision: 'approve' })
      })
      assert.equal(response.status, 200, await response.text())
    })().then(approve.resolve, approve.reject)
  })
  const [loginResult] = await Promise.all([login, approval])
  const signedIn = successful(loginResult)
  assert.equal(signedIn.user.id, user.id)
  assert.equal(await models.PersonalAccessToken.count(), 1)
  assert.ok(!/specdoc_[a-f0-9]{64}/.test(loginResult.stdout + loginResult.stderr))
  const status = successful(await cli(['auth', 'status', '--format', 'json'], env))
  assert.equal(status.verified, true)

  const source = path.join(temporary, 'new.md')
  fs.writeFileSync(source, '---\ntags: [spec, draft]\n---\n# Test λ\n\nOriginal without final newline')
  const created = successful(await cli(['note', 'create', '--body-file', source, '--format', 'json'], env))
  assert.equal(await models.Note.count(), 1)
  const checkout = path.join(temporary, 'checked.md')
  const checked = successful(await cli(['note', 'checkout', created.id, '--output', checkout, '--format', 'json'], env))
  assert.equal(fs.readFileSync(checkout, 'utf8'), fs.readFileSync(source, 'utf8'))
  fs.appendFileSync(checkout, '\r\nNew requirement λ')
  const key = crypto.randomUUID()
  const updated = successful(await cli(['note', 'update', '--state', checked.state, '--body-file', checkout, '--operation-key', key, '--format', 'json'], env))
  assert.equal(updated.operationKey, key)
  assert.equal(droppedUpdates, 1)
  assert.equal(await models.PublicOperation.count(), 2)
  assert.equal((await models.Note.findOne()).content, fs.readFileSync(checkout, 'utf8').replace(/\r\n?/g, '\n'))
  const receipt = successful(await cli(['operation', 'get', key, '--format', 'json'], env))
  assert.equal(receipt.state, 'completed')
  const stale = await cli(['note', 'update', '--state', checked.state, '--body-file', checkout, '--format', 'json'], env)
  assert.equal(stale.code, 1)
  assert.equal(JSON.parse(stale.stderr).error.code, 'PRECONDITION_FAILED')
  assert.equal(await models.PublicOperation.count(), 2)
  const loggedOut = successful(await cli(['auth', 'logout', '--format', 'json'], env))
  assert.equal(loggedOut.revocation, 'confirmed')
  assert.ok((await models.PersonalAccessToken.findOne()).revokedAt)
  console.log('Real CLI/editor device login, raw checkout, guarded update, lost-response recovery and logout passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const child of children) child.kill('SIGKILL')
  if (server) await new Promise(resolve => server.close(resolve))
  if (models) await models.sequelize.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}).then(() => process.exit(process.exitCode || 0))
