const assert = require('assert/strict')
const { createReviewService, actorOf, actionInput, pageOptions, sourceDTO } = require('./review-service')

const actor = { provider: 'github', subject: '123', login: 'alice' }
const requestId = 'request-0000000001'
const input = { body: 'A general question.', requestId }
const original = { id: 'note', title: 'A proposal', namespace: 'team/specs', permission: 'editable',
  content: 'The requirements.', ownerSubject: '123', authorLogin: 'alice', authorEmail: 'private@example.test', ownerToken: 'private' }

async function main () {
  assert.deepEqual(actorOf({ provider: 'github', subject: '123', username: 'alice' }), actor)
  assert.deepEqual(actorOf({ ...actor, login: 'legacy-' }), { ...actor, login: 'legacy-' }, 'display labels use the editor assertion format')
  const signedIn = Date.now() - 7200000
  assert.equal(actorOf({ ...actor, authenticatedAt: signedIn }).authenticatedAt, signedIn,
    'normalizing an assertion does not refresh its authentication time')
  for (const invalid of [null, { ...actor, subject: '0' }, { ...actor, subject: 123 }, { ...actor, provider: 'local' }, { ...actor, login: '<alice>' }]) {
    assert.throws(() => actorOf(invalid), { status: 401 })
  }
  const parsed = actionInput('thread', input)
  for (const body of ['-----BEGIN PRIVATE KEY-----', 'ghp_' + 'a'.repeat(36), 'AKIA' + 'A'.repeat(16)]) {
    assert.throws(() => actionInput('thread', { ...input, body }), { status: 422, code: 'review-sensitive-content' })
  }
  assert.equal(parsed.payload.body, input.body)
  assert.equal(parsed.requestHash, actionInput('thread', { requestId, body: input.body }).requestHash)
  assert.notEqual(parsed.requestHash, actionInput('thread', { ...input, body: input.body + ' ' }).requestHash)
  for (const [action, payload] of [
    ['delete', input], ['thread', { ...input, injected: true }], ['thread', { ...input, body: '' }],
    ['thread', { ...input, body: 'x'.repeat(8001) }], ['thread', { ...input, body: 'hidden\u0000text' }],
    ['thread', { ...input, requestId: 'short' }], ['reply', { ...input, threadId: '1' }],
    ['reply', { ...input, threadId: '9223372036854775808', version: 1 }],
    ['resolve', { requestId, threadId: '1', version: 0 }]
  ]) assert.throws(() => actionInput(action, payload), { status: 400 })
  assert.equal(actionInput('reply', { ...input, threadId: '1', version: 2 }).payload.version, 2)
  assert.throws(() => pageOptions({ limit: 21 }), { status: 400 })
  assert.throws(() => pageOptions({ messageAfter: '3' }), { status: 400 })
  assert.throws(() => pageOptions({ threadId: '1', after: '3' }), { status: 400 })
  assert.deepEqual(pageOptions({ threadId: '1', messageAfter: '3' }), { threadId: '1', messageAfter: '3', limit: 20, messageLimit: 20, activityLimit: 50 })
  assert.deepEqual(Object.keys(sourceDTO(original)), ['id', 'title', 'namespace', 'owner', 'contentHash'])
  assert.ok(!JSON.stringify(sourceDTO(original)).includes('private'))

  let source = { ...original }
  let allowed = true
  let sourceReads = 0
  let validates = 0
  let notifications = 0
  let authorization
  let replay = false
  let inMutation = false
  let beforeMutation = () => {}
  let prepareCalls = 0
  let afterRead = () => {}
  let admissions = 0
  let admissionError = null
  const store = {
    async admit () { if (admissionError) throw admissionError; admissions++ },
    async mutate (args) {
      beforeMutation()
      inMutation = true
      try {
        await args.validate({ transaction: true }, { id: '1', starter: { subject: 'other' } })
        validates++
        return { noteId: args.noteId, action: args.action, eventId: '1', replayed: replay }
      } finally { inMutation = false }
    },
    async read (noteId, options, validate) {
      await validate({ transaction: true })
      afterRead()
      return { noteId, threads: [], activity: [], options }
    },
    async context (noteId, options, validate) {
      await validate({ transaction: true })
      afterRead()
      return { noteId, threads: [], complete: true }
    }
  }
  const service = createReviewService({ store,
    loadSource: async () => { sourceReads++; return source },
    prepareAuthorize: async args => {
      assert.equal(inMutation, false, 'remote authorization preparation runs before mutation locks')
      assert.ok(admissions > prepareCalls, 'attempt admission precedes remote authorization')
      assert.equal(args.noteId, 'note')
      prepareCalls++
      return { namespace: source?.namespace, eligible: allowed }
    },
    authorize: async args => {
      assert.equal(inMutation, true, 'fresh source and thread authorization remain inside the transaction')
      authorization = args
      return args.authorization.eligible && args.authorization.namespace === args.source.namespace
    },
    notify: async () => { notifications++ }
  })
  await service.act('note', actor, 'thread', input)
  assert.equal(validates, 1)
  assert.equal(authorization.db.transaction, true)
  assert.equal(authorization.actor.subject, actor.subject)
  assert.equal(authorization.authorization.namespace, original.namespace)
  assert.equal(prepareCalls, 1)
  assert.equal(notifications, 1)
  admissionError = Object.assign(new Error('Try again later.'), { status: 429 })
  await assert.rejects(service.act('note', actor, 'thread', input), { status: 429 })
  assert.equal(prepareCalls, 1, 'exhausted attempts cannot make further policy requests')
  admissionError = null
  replay = true
  await service.act('note', actor, 'thread', input)
  assert.equal(notifications, 1, 'a receipt replay does not send another notification')
  allowed = false
  await assert.rejects(service.act('note', actor, 'thread', input), { status: 403 })
  assert.equal(notifications, 1, 'replay still requires current authorization')
  allowed = true
  beforeMutation = () => { source = { ...original, namespace: 'another/specs' } }
  await assert.rejects(service.act('note', actor, 'thread', input), { status: 403 },
    'a namespace change after preflight cannot grant stale project authorization')
  beforeMutation = () => {}
  for (const permission of ['private', 'limited', 'protected']) {
    source = { ...original, permission }
    await assert.rejects(service.act('note', actor, 'thread', input), { status: 404 })
    await assert.rejects(service.read('note'), { status: 404 })
  }
  source = { ...original, hidden: true }
  await assert.rejects(service.context('note'), { status: 404 })
  source = null
  await assert.rejects(service.act('note', actor, 'thread', input), { status: 404 })
  source = { ...original }
  sourceReads = 0
  await service.read('note')
  assert.equal(sourceReads, 2, 'public responses recheck live visibility after reading discussion data')
  afterRead = () => { source = { ...original, permission: 'private' } }
  await assert.rejects(service.read('note'), { status: 404 })
  source = { ...original }
  await assert.rejects(service.context('note'), { status: 404 })
  source = { ...original }
  afterRead = () => {}
  await assert.rejects(service.context('note', { maxBytes: 1000001 }), { status: 400 })
  await assert.rejects(service.read('../note'), { status: 400 })
  const failingNotify = createReviewService({ store, loadSource: async () => original,
    authorize: async () => true, notify: async () => { throw new Error('delivery unavailable') } })
  replay = false
  assert.equal((await failingNotify.act('note', actor, 'thread', input)).replayed, false,
    'notification failure cannot undo an acknowledged discussion mutation')
  console.log('review service tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
