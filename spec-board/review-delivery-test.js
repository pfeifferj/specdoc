const assert = require('node:assert/strict')
const { test } = require('node:test')
const { prepareDelivery, deliverReview, MAX_ATTEMPTS, RETENTION_MS, MAX_DELIVERY_BYTES } = require('./review-delivery')

function fixture () {
  let time = 1000
  let stored = prepareDelivery({ noteIds: ['a', 'b'], findings: [{ findingKey: 'first' }, { findingKey: 'second' }],
    mutation: { operationId: 'stable-operation', noteId: 'a', content: 'A requirement. {>>Review.<<}' } }, time)
  const writes = [], findings = []
  let failure = null, editorFailure = null, owned = true
  const run = () => deliverReview(structuredClone(stored), {
    now: () => time, retryMs: 1000,
    save: async value => { if (!owned) return false; stored = structuredClone(value); return true },
    assertActive: () => {},
    recordFinding: async finding => {
      findings.push(finding.findingKey)
      if (failure && finding.findingKey === 'first') throw failure
    },
    mutate: async mutation => { writes.push(structuredClone(mutation)); if (editorFailure) throw editorFailure }
  })
  return { run, writes, findings, get stored () { return stored },
    advance: () => { time = stored.retryAt }, setFailure: error => { failure = error },
    setEditorFailure: error => { editorFailure = error }, expire: () => { time += RETENTION_MS + 1 },
    loseGeneration: () => { owned = false } }
}

test('a partial finding save resumes only the saved response after durable backoff', async () => {
  const f = fixture()
  f.setFailure(Object.assign(new Error('busy'), { status: 409, code: 'review-busy' }))
  await f.run()
  assert.deepEqual(f.findings, ['first', 'second'])
  assert.deepEqual(f.stored.findings.map(item => item.findingKey), ['first'])
  assert.equal(f.writes.length, 0)
  await f.run()
  assert.equal(f.findings.length, 2, 'a new runner reading persisted state still observes backoff')
  f.advance()
  f.setFailure(null)
  await f.run()
  assert.deepEqual(f.findings, ['first', 'second', 'first'])
  assert.equal(f.writes.length, 1)
  assert.equal(f.stored, null)
})

test('an ambiguous editor acknowledgement replays the same immutable operation', async () => {
  const f = fixture()
  f.setEditorFailure(new Error('response lost'))
  await f.run()
  const mutation = f.writes[0]
  assert.deepEqual(f.stored.mutation, mutation)
  await f.run()
  assert.equal(f.writes.length, 1)
  f.advance()
  f.setEditorFailure(null)
  await f.run()
  assert.deepEqual(f.writes, [mutation, mutation])
  assert.equal(f.findings.length, 2, 'committed findings are not replayed with the editor operation')
  assert.equal(f.stored, null)
})

for (const error of [{ status: 403 }, { status: 404 }, { status: 422 }, { status: 409, code: 'review-source-changed' }]) {
  test(`terminal finding ${error.code || error.status} does not delay independent delivery`, async () => {
    const f = fixture()
    f.setFailure(Object.assign(new Error('terminal'), error))
    await f.run()
    assert.deepEqual(f.findings, ['first', 'second'])
    assert.equal(f.writes.length, 1)
    assert.equal(f.stored.state, 'failed')
    assert.equal(f.stored.rejected, 1)
    assert.ok(!JSON.stringify(f.stored).includes('A requirement'))
    await f.run()
    assert.equal(f.writes.length, 1)
  })
}

test('persistent storage failure has a finite attempt limit and retains no source text', async () => {
  const f = fixture()
  f.setFailure(new Error('offline'))
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await f.run(); if (f.stored.state === 'pending') f.advance() }
  assert.equal(f.findings.filter(key => key === 'first').length, MAX_ATTEMPTS)
  assert.equal(f.writes.length, 1, 'saved inline remarks are delivered after the finding retry limit')
  assert.equal(f.stored.state, 'failed')
  assert.ok(!Object.hasOwn(f.stored, 'findings'))
  await f.run()
  assert.equal(f.findings.filter(key => key === 'first').length, MAX_ATTEMPTS)
})

test('expiry removes pending content without making this generation eligible again', async () => {
  const f = fixture()
  f.expire()
  await f.run()
  assert.deepEqual(f.findings, [])
  assert.deepEqual(f.writes, [])
  assert.equal(f.stored.state, 'failed')
  assert.equal(f.stored.reason, 'expired')
  assert.ok(!Object.hasOwn(f.stored, 'mutation'))
})

test('a replaced generation cannot write comments or findings', async () => {
  const f = fixture()
  f.loseGeneration()
  await assert.rejects(f.run(), error => error.code === 'review-delivery-replaced')
  assert.deepEqual(f.findings, [])
  assert.deepEqual(f.writes, [])
})

test('editor delivery also stops after its attempt limit and drops stored text', async () => {
  const f = fixture()
  f.setEditorFailure(Object.assign(new Error('editor offline'), { status: 503 }))
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await f.run(); if (f.stored.state === 'pending') f.advance() }
  assert.equal(f.writes.length, MAX_ATTEMPTS)
  assert.equal(new Set(f.writes.map(write => write.operationId)).size, 1)
  assert.equal(f.stored.state, 'failed')
  assert.ok(!Object.hasOwn(f.stored, 'mutation'))
  await f.run()
  assert.equal(f.writes.length, MAX_ATTEMPTS)
})

test('an open editor delays the saved review until it closes or the response expires', async () => {
  const f = fixture()
  f.setEditorFailure(Object.assign(new Error('Editor open'), { status: 409 }))
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await f.run()
    assert.equal(f.stored.state, 'pending')
    assert.equal(f.stored.attempts, 0)
    f.advance()
  }
  assert.equal(new Set(f.writes.map(write => write.operationId)).size, 1)
  f.setEditorFailure(null)
  await f.run()
  assert.equal(f.stored, null)

  const expired = fixture()
  expired.setEditorFailure(Object.assign(new Error('Editor still open'), { status: 409 }))
  await expired.run()
  expired.expire()
  await expired.run()
  assert.equal(expired.stored.state, 'failed')
  assert.equal(expired.stored.reason, 'expired')
  assert.equal(expired.writes.length, 1)
})

test('the full persisted response is bounded and checked for credentials', () => {
  const data = { noteIds: ['a'], findings: [], mutation: { content: 'ghp_' + 'x'.repeat(36) } }
  assert.throws(() => prepareDelivery(data), { code: 'SENSITIVE_CONTENT' })
  data.mutation.content = '€'.repeat(Math.ceil(MAX_DELIVERY_BYTES / 3))
  assert.throws(() => prepareDelivery(data), { code: 'review-delivery-too-large' })
})
