const assert = require('assert/strict')
const { createLifecycle } = require('./lifecycle')
const { createEditorClient, contentHash } = require('./editor-client')
const crypto = require('crypto')

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function main () {
  const exits = [], events = []
  const stateCommit = deferred()
  const life = createLifecycle({ exit: code => exits.push(code) })
  const model = life.track(new Promise(resolve => life.signal.addEventListener('abort', () => { events.push('model cancelled'); resolve() })))
  life.track(stateCommit.promise.then(() => events.push('remote result recorded')))
  const draining = life.shutdown({ closeServer: async () => {}, closePool: async () => events.push('pool closed') })
  await model
  assert.equal(life.stopping, true)
  assert.deepEqual(events, ['model cancelled'])
  stateCommit.resolve()
  await draining
  assert.deepEqual(events, ['model cancelled', 'remote result recorded', 'pool closed'])
  assert.deepEqual(exits, [0])

  let hardDeadline
  const stuckExits = []
  const stuck = createLifecycle({ exit: code => stuckExits.push(code), clock: {
    setTimeout: fn => { hardDeadline = fn; return 1 }, clearTimeout: () => {}
  } })
  stuck.shutdown({ closeServer: async () => {}, closePool: () => new Promise(() => {}) })
  await Promise.resolve()
  hardDeadline()
  assert.deepEqual(stuckExits, [1], 'pool closure cannot defer the hard exit')

  let requests = 0, wireBody
  const secret = 'test-secret'
  const mutation = { noteId: 'note-one', operationId: crypto.randomUUID(), operation: 'review',
    expectedHash: contentHash('old'), expectedPermission: 'editable', content: 'new' }
  const client = createEditorClient({ url: 'https://notes.test/', secret, fetch: async (url, init) => {
    requests++
    if (wireBody) assert.equal(init.body, wireBody, 'recovered JSONB key ordering preserves receipt identity')
    wireBody = init.body
    assert.equal(url, 'https://notes.test/internal/spec-board/v1/mutate')
    assert.equal(init.redirect, 'error')
    const [payload, mac] = init.headers.authorization.slice(7).split('.')
    assert.equal(mac, crypto.createHmac('sha256', secret).update(payload).digest('base64url'))
    const assertion = JSON.parse(Buffer.from(payload, 'base64url'))
    assert.equal(assertion.purpose, 'spec-board-mutation')
    assert.equal(assertion.version, 1)
    assert.equal(assertion.bodyHash, contentHash(init.body))
    assert.ok(!init.headers.authorization.includes('content'))
    assert.deepEqual(JSON.parse(init.body), { ...mutation, version: 1 })
    return { ok: true, json: async () => ({ version: 1, noteId: mutation.noteId, contentHash: contentHash('new'), permission: 'editable', applied: true }) }
  } })
  assert.equal((await client(mutation)).applied, true)
  await client(Object.fromEntries(Object.entries(mutation).reverse()))
  assert.equal(requests, 2)
  await assert.rejects(createEditorClient({ url: 'https://notes.test' })(mutation), /not configured/)
  await assert.rejects(createEditorClient({ url: 'https://notes.test', secret, fetch: async () => ({ ok: false, status: 404 }) })(mutation), error => error.status === 404)
  await assert.rejects(createEditorClient({ url: 'https://notes.test', secret, fetch: async () => ({ ok: true, json: async () => ({}) }) })(mutation), /incompatible/)
  console.log('lifecycle and editor client tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
