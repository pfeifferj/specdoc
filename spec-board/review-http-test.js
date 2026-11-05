const assert = require('assert/strict')
const crypto = require('crypto')
const { reviewIdentity, createReviewHttp } = require('./review-http')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const now = Date.now()
const payload = { body: 'Can we retain the older requirement until the replacement is published?', requestId: 'review-request-0001' }
const who = { version: 1, purpose: 'spec-review', provider: 'github', subject: '1234', username: 'alice',
  noteId: 'note', action: 'thread', payloadHash: digest(JSON.stringify(payload)), requestId: payload.requestId, exp: now + 60000 }
assert.equal(reviewIdentity('token', 'note', 'thread', payload, () => who, now).subject, '1234')
for (const change of [{ purpose: 'spec-approval' }, { noteId: 'another' }, { action: 'resolve' },
  { subject: 'anonymous' }, { username: '<script>' }, { exp: now }, { exp: now + 600001 }, { requestId: 'another' }]) {
  assert.throws(() => reviewIdentity('token', 'note', 'thread', payload, () => ({ ...who, ...change }), now), { status: 401 })
}
assert.throws(() => reviewIdentity('token', 'note', 'thread', { ...payload, body: 'Changed body' }, () => who, now), { status: 401 })
const summaryPayload = { sourceHash: 'a'.repeat(64), requestId: payload.requestId }
const summarizer = { ...who, action: 'summarize', payloadHash: digest(JSON.stringify(summaryPayload)), sourceHash: summaryPayload.sourceHash }
assert.equal(reviewIdentity('token', 'note', 'summarize', summaryPayload, () => summarizer, now).login, 'alice')
assert.throws(() => reviewIdentity('token', 'note', 'summarize', summaryPayload, () => ({ ...summarizer, sourceHash: 'b'.repeat(64) }), now), { status: 401 })

async function main () {
  let generated = 0, acted = 0
  const source = { id: 'note', namespace: 'team/specs', contentHash: 'a'.repeat(64) }
  const http = createReviewHttp({ origin: 'https://notes.example.test', verify: () => who,
    loadSource: async () => source, readBody: async () => JSON.stringify({ token: 'token', action: 'thread', payload }),
    record: async () => ({ approvedBy: [] }),
    service: { read: async () => ({ threads: [], activity: [], openDiscussions: 0 }),
      act: async () => { acted++; return { replayed: false } } },
    summary: { peek: async () => ({ status: 'missing' }), generate: async () => { generated++; return {} } } })
  const response = () => ({ status: null, body: null, writeHead (status, headers) { this.status = status; this.headers = headers; return this },
    end (body) { this.body = body && JSON.parse(body) } })
  let res = response()
  await http.handle({ method: 'GET' }, res, 'note', new URL('https://board.example.test/api/note/note/review'))
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(res.body.sourceHash, source.contentHash)
  assert.equal(generated, 0, 'public reads cannot start model work')
  res = response()
  await http.handle({ method: 'POST' }, res, 'note', new URL('https://board.example.test/api/note/note/review'))
  assert.equal(res.status, 200)
  assert.equal(acted, 1)
  res = response()
  await http.handle({ method: 'POST' }, res, 'another-note', new URL('https://board.example.test/api/note/another-note/review'))
  assert.equal(res.status, 401)
  assert.equal(acted, 1)
  const unavailable = createReviewHttp({ origin: 'https://notes.example.test', enabled: true,
    service: { read: async () => ({ threads: [], activity: [], openDiscussions: 0 }) },
    loadSource: async () => { throw Object.assign(new Error('upstream credential sentinel'), { status: 503 }) } })
  res = response()
  await unavailable.handle({ method: 'GET' }, res, 'note', new URL('https://board.example.test/api/note/note/review'))
  assert.equal(res.status, 503)
  assert.ok(!JSON.stringify(res.body).includes('credential sentinel'), 'provider failures cannot become public error text')
  console.log('review HTTP: purpose, payload and note binding; cache-only reads passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
