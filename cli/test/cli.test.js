'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { parse } = require('../lib/main')
const binary = process.env.SPECDOC_TEST_BINARY || path.resolve(__dirname, '../bin/specdoc.js')
const hash = require('../lib/client').digest
function run (args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', s => { stdout += s }); child.stderr.on('data', s => { stderr += s })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}
test('exact parsing, duplicate rejection and offline schemas', async () => {
  assert.throws(() => parse(['spec', 'list', '--limit', '2', '--limit', '3']), /Duplicate/)
  assert.throws(() => parse(['spec', 'l']), /Unknown command/)
  assert.throws(() => parse(['note', 'create', '--body-file', '-', '--token-stdin']), /both/)
  const result = await run(['schema', 'note.update', '--format', 'json'], { SPECDOC_CONFIG_DIR: '/does/not/exist' })
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).data.operation, 'note.update'); assert.equal(result.stderr, '')
  const invalid = await run(['spec', 'list', '--surprise', '--format=json'], {})
  assert.equal(invalid.code, 2); assert.equal(invalid.stdout, ''); assert.equal(JSON.parse(invalid.stderr).error.code, 'USAGE')
})
test('remote workflows preserve source, guards, origins and mutation identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let content = '---\ntags: [spec]\n---\nUnicode λ and ``` fence\nno final newline'
  let etag = '"' + hash(content) + '"'; let calls = 0; let writes = 0; let creates = 0; let dropped = false
  const receipts = new Map(); const requests = []
  const server = http.createServer(async (req, res) => {
    calls++; const url = new URL(req.url, 'http://localhost'); let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ url: req.url, key: req.headers['idempotency-key'], guard: req.headers['if-match'], authorization: req.headers.authorization, raw })
    const json = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/.well-known/specdoc') return json(200, { protocolVersion: 1, capabilities: { publicReceipts: true } })
    if (url.pathname === '/api/v1/auth') return json(200, { user: { id: 'user-1', name: 'Fixture' }, token: { id: 'token-1', scopes: ['notes:read', 'notes:write'], expiresAt: '2030-01-01T00:00:00.000Z' } })
    if (url.pathname === '/api/v1/auth/token' && req.method === 'DELETE') return json(200, { revoked: true })
    if (url.pathname === '/api/specs') return json(200, { specs: [{ id: 'abcdefg', title: 'Example', namespace: 'org/specs', pr: 6 }], next: url.searchParams.get('cursor') ? null : 'opaque' })
    if (url.pathname === '/api/specs/abcdefg/revisions') return json(200, { revisions: [{ time: 'current' }] })
    if (url.pathname === '/api/specs/abcdefg/revisions/current') { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end(content) }
    if (url.pathname === '/api/specs/abcdefg/changes') return json(200, { from: { id: 1 }, to: { id: 2 }, diff: 'changed', same: false })
    if (url.pathname === '/api/specs/abcdefg') return json(200, { id: 'abcdefg', body: 'Rendered' })
    if (url.pathname === '/api/v1/notes/abcdefg' && req.method === 'GET') return json(200, { id: 'abcdefg', content }, { etag })
    if (url.pathname.startsWith('/api/v1/operations/')) {
      const key = url.pathname.split('/').pop(); return receipts.has(key) ? json(200, { key, state: 'completed', status: 200, result: receipts.get(key) }) : json(404, { error: 'Not found' })
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/notes') {
      const key = req.headers['idempotency-key']
      if (receipts.has(key)) return json(201, receipts.get(key))
      creates++; const result = { id: 'created', etag: '\"' + hash(JSON.parse(raw).content) + '\"' }; receipts.set(key, result)
      req.socket.destroy(); return
    }
    if (req.method === 'PUT') {
      assert.equal(req.headers.prefer, 'return=minimal')
      const key = req.headers['idempotency-key']
      if (receipts.has(key)) return json(200, receipts.get(key))
      if (req.headers['if-match'] !== etag) return json(412, { error: 'Stale guard' })
      writes++; content = JSON.parse(raw).content; etag = '"' + hash(content) + '"'
      const result = { id: 'abcdefg', etag, hash: hash(content), written: true }
      receipts.set(key, result)
      if (!dropped) { dropped = true; req.socket.destroy(); return }
      return json(200, result)
    }
    if (url.pathname === '/api/bot/notes/abcdefg') return json(200, { id: 'abcdefg', content, hash: hash(content), threads: [] })
    if (url.pathname.endsWith('/comments')) return json(200, { written: true, hash: hash('comment') })
    if (url.pathname.endsWith('/suggestions')) return json(200, { written: true, hash: hash('suggestion'), placed: 0, unanchored: 1 })
    if (url.pathname.endsWith('/replies')) return json(200, { written: true, hash: hash('reply') })
    return json(404, { error: 'Not found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { SPECDOC_CONFIG_DIR: path.join(dir, 'config'), SPECDOC_EDITOR_URL: origin, SPECDOC_BOARD_URL: origin, SPECDOC_TOKEN: 'specdoc_' + 'a'.repeat(64), SPECDOC_BOT_TOKEN: 'b'.repeat(32) }
  let result = await run(['auth', 'login', '--format=json'], env)
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stderr).error.code, 'UNSUPPORTED_FEATURE')
  assert.match(JSON.parse(result.stderr).error.message, /Deploy the updated SpecDoc editor/)
  assert.deepEqual(requests.map(request => request.url), ['/.well-known/specdoc'])
  assert.equal(requests[0].authorization, undefined)
  assert.equal(fs.existsSync(env.SPECDOC_CONFIG_DIR), false)
  result = await run(['spec', 'list', '--limit', '1', '--fields', 'id,title', '--format=json'], env)
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).page, { nextCursor: 'opaque', complete: false })
  const beforeInvalid = calls
  result = await run(['spec', 'list', '--fields', 'bad', '--format=json'], env)
  assert.equal(result.code, 2); assert.equal(calls, beforeInvalid)
  result = await run(['spec', 'get', 'org/specs#6', '--format=markdown'], env)
  assert.equal(result.stdout, 'Rendered')
  result = await run(['spec', 'revisions', 'abcdefg', '--format=json'], env)
  assert.equal(JSON.parse(result.stdout).data.revisions[0].time, 'current')
  result = await run(['spec', 'get', 'abcdefg', '--revision=current', '--format=markdown'], env)
  assert.equal(result.stdout, content)
  result = await run(['spec', 'changes', 'abcdefg', '--format=json'], env)
  assert.equal(JSON.parse(result.stdout).data.diff, 'changed')
  result = await run(['note', 'create', '--body-file=-', '--format=json'], env, 'New note')
  assert.equal(result.code, 0, result.stderr); assert.equal(creates, 1)
  const file = path.join(dir, 'spec.md'); const state = file + '.specdoc.json'
  result = await run(['note', 'checkout', `${origin}/abcdefg`, '--output', file, '--format=json'], env)
  assert.equal(result.code, 0, result.stderr); assert.equal(fs.readFileSync(file, 'utf8'), content)
  const originalGuard = JSON.parse(fs.readFileSync(state)).etag
  fs.appendFileSync(file, '\r\nNew line λ')
  result = await run(['note', 'diff', '--state', state, '--body-file', file, '--format=json'], env)
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).data.changed, true)
  const key = require('node:crypto').randomUUID()
  result = await run(['note', 'update', '--state', state, '--body-file', file, '--operation-key', key, '--format=json'], env)
  assert.equal(result.code, 0, result.stderr); assert.equal(writes, 1); assert.equal(JSON.parse(result.stdout).data.operationKey, key)
  const retries = requests.filter(r => r.key === key)
  assert.equal(retries.length, 2); assert.equal(retries[0].raw, retries[1].raw); assert.equal(retries[1].guard, originalGuard); assert.ok(!content.includes('\r'))
  result = await run(['operation', 'get', key, '--format=json'], env)
  assert.equal(JSON.parse(result.stdout).data.state, 'completed')
  result = await run(['note', 'update', '--state', state, '--body-file', file, '--format=json'], env)
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, 'PRECONDITION_FAILED'); assert.equal(writes, 1)
  const beforeHostile = calls
  result = await run(['note', 'get', 'https://evil.invalid/abcdefg', '--format=json'], env)
  assert.equal(result.code, 2); assert.equal(calls, beforeHostile)
  result = await run(['review', 'get', 'abcdefg', '--format=markdown'], env)
  assert.equal(result.stdout, content)
  result = await run(['review', 'comment', 'abcdefg', '--expected-hash', hash(content), '--body-file=-', '--format=json'], env, JSON.stringify([{ text: 'Comment' }]))
  assert.equal(result.code, 0, result.stderr)
  result = await run(['review', 'suggest', 'abcdefg', '--expected-hash', hash(content), '--body-file=-', '--format=json'], env, JSON.stringify([{ quote: 'missing', replacement: 'new', rationale: 'Reason' }]))
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).data.unanchored, 1)
  result = await run(['review', 'reply', 'abcdefg', '--expected-hash', hash(content), '--thread', 'comment-1', '--body-file', '-', '--format=json'], env, 'Review reply')
  assert.equal(result.code, 0, result.stderr)
  result = await run(['note', 'get', 'abcdefg', '--format=markdown'], env)
  assert.equal(result.stdout, content)
  result = await run(['auth', 'login', '--token-stdin', '--storage', 'file', '--format=json'], env, env.SPECDOC_TOKEN)
  assert.equal(result.code, 0, result.stderr)
  result = await run(['note', 'get', 'abcdefg', '--format=markdown'], { ...env, SPECDOC_TOKEN: '' })
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, content)
  const stdinToken = 'specdoc_' + 'c'.repeat(64)
  result = await run(['auth', 'status', '--token-stdin', '--offline', '--format=json'], env, stdinToken)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.credentialSource, 'stdin')
  assert.equal(JSON.parse(result.stdout).data.user, undefined)
  result = await run(['auth', 'logout', '--token-stdin', '--format=json'], env, stdinToken)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(requests.at(-1).authorization, `Bearer ${stdinToken}`)
  assert.equal(JSON.parse(result.stdout).data.localRemoved, false)
  assert.equal(JSON.parse(result.stdout).data.storedCredentialRetained, true)
  const beforeEmptyCredential = calls
  result = await run(['auth', 'logout', '--token-stdin', '--format=json'], env)
  assert.equal(result.code, 2); assert.equal(calls, beforeEmptyCredential)
  result = await run(['auth', 'status', '--offline', '--format=json'], { ...env, SPECDOC_TOKEN: '' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.credentialSource, 'stored')
  const records = fs.readdirSync(path.join(env.SPECDOC_CONFIG_DIR, 'operations')).map(f => fs.readFileSync(path.join(env.SPECDOC_CONFIG_DIR, 'operations', f), 'utf8')).join('\n')
  assert.ok(!records.includes(env.SPECDOC_TOKEN)); assert.ok(!records.includes('New line λ'))
})
