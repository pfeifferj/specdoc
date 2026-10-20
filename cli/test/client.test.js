'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { request, mutation } = require('../lib/client')
test('HTTP errors never expose a credential echoed by the service', async () => {
  const token = 'specdoc_' + 'a'.repeat(64)
  const fetch = async () => new Response(JSON.stringify({ code: `error-${token}`, error: `Rejected ${token}`, nested: { authorization: `Bearer ${token}` } }), { status: 403, headers: { 'content-type': 'application/json' } })
  await assert.rejects(request('https://example.test', '/api/v1/notes/a', { token, fetch }), error => {
    assert.ok(!JSON.stringify(error).includes(token)); assert.ok(!error.message.includes(token)); return true
  })
})
test('a known successful mutation survives failure to update its recovery record', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-client-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const originalFetch = global.fetch; const originalRename = fs.renameSync
  t.after(() => { global.fetch = originalFetch; fs.renameSync = originalRename })
  let sends = 0; let records = 0
  fs.renameSync = (...args) => { if (++records > 1) throw new Error('Disk failure'); return originalRename(...args) }
  global.fetch = async url => {
    if (String(url).endsWith('/.well-known/specdoc')) return new Response(JSON.stringify({ capabilities: { publicReceipts: true } }), { headers: { 'content-type': 'application/json' } })
    sends++
    return new Response(JSON.stringify({ id: 'abc', etag: 'new' }), { headers: { 'content-type': 'application/json' } })
  }
  const result = await mutation({ configDir: dir, profile: 'test', editorOrigin: 'https://example.test', authorToken: 'private' }, 'author', '/api/v1/notes', 'POST', { content: 'body' })
  assert.equal(sends, 1); assert.equal(result.data.id, 'abc'); assert.match(result.data.warning, /succeeded/)
})
test('unadvertised receipt support disables automatic mutation retries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-client-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch })
  let sends = 0
  global.fetch = async url => {
    if (String(url).endsWith('/.well-known/specdoc')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    sends++; throw new TypeError('Network failure')
  }
  await assert.rejects(mutation({ configDir: dir, profile: 'test', editorOrigin: 'https://example.test', authorToken: 'private' }, 'author', '/api/v1/notes', 'POST', { content: 'body' }), { code: 'OUTCOME_UNKNOWN' })
  assert.equal(sends, 1)
})
