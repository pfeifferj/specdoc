const assert = require('assert/strict')
const { createReviewService, actorOf, actionInput, pageOptions, sourceDTO } = require('./review-service')
const { digest } = require('./review-store')

const actor = { provider: 'github', subject: '123', login: 'alice' }
const requestId = 'request-0000000001'
const input = { body: 'A general question.', requestId }
const original = { id: 'note', title: 'A proposal', namespace: 'team/specs', permission: 'editable',
  content: 'The requirements.', ownerSubject: '123', authorLogin: 'alice', authorEmail: 'private@example.test', ownerToken: 'private' }

async function automationAuthorization () {
  const bodies = { note: 'FR-001: Keep the original string.', second: 'FR-002: Parse the original string.' }
  const sources = Object.fromEntries(Object.entries(bodies).map(([id, body]) => [id,
    { ...original, id, body, content: body, contentHash: digest(body) }]))
  const finding = { actor: { kind: 'automation', id: 'review-bot', login: 'Review bot' }, producer: 'spec-review', kind: 'conflict',
    body: 'These requirements disagree.', occurrenceKey: digest('run'), evidence: Object.entries(bodies).map(([noteId, body]) =>
      ({ noteId, body, contentHash: digest(body), quote: body.slice(8) })) }
  let saved = 0
  let transaction = false
  let prepared = false
  let denied = null
  let beforeSave = () => {}
  const seen = []
  const store = { async upsertFinding ({ finding, validate }) {
    beforeSave()
    transaction = true
    try {
      const result = await validate({ transaction: true })
      assert.equal(result.namespace, 'team/specs')
      assert.equal(finding.actor.subject, 'automation:review-bot')
      saved++
      return { noteId: 'note', noteIds: ['note', 'second'], replayed: false }
    } finally { transaction = false }
  } }
  const service = createReviewService({ store, loadSource: async (id, db, { lock } = {}) => {
    assert.equal(transaction, true)
    assert.equal(lock, true)
    return sources[id]
  }, authorize: async () => true,
  prepareAutomation: async ({ actor, noteIds }) => {
    assert.equal(transaction, false)
    assert.equal(actor.kind, 'automation')
    assert.deepEqual(noteIds, ['note', 'second'])
    prepared = true
    return { eligible: true }
  }, authorizeAutomation: async ({ actor, source, sources, db, authorization }) => {
    assert.equal(prepared, true)
    assert.equal(db.transaction, true)
    assert.equal(authorization.eligible, true)
    assert.equal(sources.length, 2)
    assert.equal(actor.subject, 'automation:review-bot')
    seen.push(source.id)
    return source.id !== denied
  } })
  await service.recordFinding(finding)
  assert.deepEqual(seen, ['note', 'second'])
  assert.equal(saved, 1)
  denied = 'second'
  await assert.rejects(service.recordFinding(finding), { status: 403 })
  assert.equal(saved, 1, 'permission on one source cannot authorize the shared write')
  denied = null
  beforeSave = () => { sources.second = { ...sources.second, body: 'Changed after the model ran.' } }
  await assert.rejects(service.recordFinding(finding), { code: 'review-source-changed' }, 'the raw hash alone cannot authenticate a forged body snapshot')
  sources.second = { ...sources.second, body: bodies.second }
  beforeSave = () => { sources.second = { ...sources.second, contentHash: digest('new raw note') } }
  await assert.rejects(service.recordFinding(finding), { code: 'review-source-changed' })
  sources.second = { ...sources.second, contentHash: digest(bodies.second) }
  beforeSave = () => { sources.second = { ...sources.second, namespace: 'other/specs' } }
  await assert.rejects(service.recordFinding(finding), { status: 422 })
  sources.second = { ...sources.second, namespace: 'team/specs' }
  beforeSave = () => { sources.second = { ...sources.second, permission: 'private' } }
  await assert.rejects(service.recordFinding(finding), { status: 404 })
  await assert.rejects(service.recordFinding({ ...finding, actor }), { code: 'review-finding-invalid' }, 'human identities cannot use the automation writer')
  assert.equal(saved, 1)
}

async function sharedVisibility () {
  const sources = { note: { ...original }, peer: { ...original, id: 'peer', title: 'Private peer title' } }
  let blocked = null
  let blockedStatus = 403
  let blockedPeerFirst = false
  let resolved = false
  let recovery = false
  let suspendPeerAfterRead = false
  let peerReads = 0
  const thread = () => ({ id: '1', version: resolved ? 2 : 1, resolved,
    associations: (blockedPeerFirst ? ['peer', 'note'] : ['note', 'peer']).map(noteId => ({ noteId, namespace: original.namespace })),
    evidence: [{ noteId: 'peer', contentHash: digest(original.content), body: original.content, quote: 'Private peer quote' }],
    messages: [{ id: '1', body: 'Private shared discussion' }] })
  const store = {
    admit: async () => {},
    read: async (id, options, validate) => { await validate(); return { threads: [thread()], activity: [], fingerprint: 'stored' } },
    context: async (id, options, validate) => { await validate(); return { threads: [thread()], complete: true, fingerprint: 'stored' } },
    findingEvidence: async () => thread(),
    mutate: async ({ validate }) => { await validate(null, thread()); resolved = true; return { replayed: true } }
  }
  const service = createReviewService({ store,
    loadSource: async id => {
      if (id === blocked || (id === 'peer' && (blockedPeerFirst || (suspendPeerAfterRead && ++peerReads > 1)))) {
        throw Object.assign(new Error('Account suspended'), { status: blockedStatus })
      }
      return sources[id]
    },
    authorize: async ({ source, recovery: requested }) => !source.unavailable || (requested && recovery)
  })
  const visible = await service.context('note')
  blocked = 'peer'
  assert.equal((await service.read('note')).threads[0].restricted, true)
  const hidden = await service.context('note')
  assert.deepEqual(hidden.threads, [])
  assert.equal(hidden.complete, true)
  assert.notEqual(hidden.fingerprint, visible.fingerprint, 'visibility changes invalidate a public summary')
  assert.ok(!JSON.stringify(hidden).includes('Private'))
  await assert.rejects(service.evidence('note', '1', 'peer'), { code: 'review-context-restricted' })
  for (const status of [403, 404]) {
    blockedStatus = status
    for (const action of ['reply', 'resolve', 'reopen']) {
      await assert.rejects(service.act('note', actor, action, {
        threadId: '1', version: 1, requestId, ...(action === 'reply' ? { body: 'Reply' } : {})
      }), { status: 409, code: 'review-context-restricted', message: 'A shared discussion includes an unavailable source.' })
    }
  }
  blockedStatus = 403
  await assert.rejects(service.act('note', actor, 'resolve', { threadId: '1', version: 1, requestId, recover: true }), { status: 403 })
  recovery = true
  await service.act('note', actor, 'resolve', { threadId: '1', version: 1, requestId, recover: true })
  const recovered = await service.context('note')
  assert.deepEqual(recovered.threads, [])
  assert.notEqual(recovered.fingerprint, hidden.fingerprint, 'restricted resolution changes remain in the fingerprint')
  blocked = 'note'
  await assert.rejects(service.read('note'), { status: 403 }, 'current-note authorization is never hidden')
  await assert.rejects(service.context('note'), { status: 403 })
  await assert.rejects(service.act('note', actor, 'resolve', { threadId: '1', version: 2, requestId, recover: true }), { status: 403 })
  blockedPeerFirst = true
  await assert.rejects(service.act('note', actor, 'resolve', { threadId: '1', version: 2, requestId }), { status: 403 },
    'a restricted peer ordered first cannot mask the current note authorization')
  blockedPeerFirst = false
  blocked = null
  resolved = false
  sources.peer.namespace = 'other/specs'
  await assert.rejects(service.act('note', actor, 'resolve', { threadId: '1', version: 1, requestId }), { status: 409, code: 'review-context-restricted' })
  await service.act('note', actor, 'resolve', { threadId: '1', version: 1, requestId, recover: true })
  assert.equal(resolved, true, 'an administrator can recover a thread after its peer moves project')
  sources.peer.namespace = original.namespace
  suspendPeerAfterRead = true
  await assert.rejects(service.evidence('note', '1', 'peer'), { code: 'review-context-restricted' },
    'a peer suspended during the evidence read stays unavailable without disclosing moderation details')
}

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
  assert.equal(actionInput('resolve', { threadId: '1', version: 1, requestId, recover: true }).payload.recover, true)
  assert.throws(() => actionInput('resolve', { threadId: '1', version: 1, requestId, recover: false }), { status: 400 })
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
  assert.deepEqual(pageOptions({ visibleThreads: '2,1,2' }).visibleThreads, ['2', '1'])
  for (const visibleThreads of ['', '1,', '0', '1;SELECT', Array(101).fill('1').join(','), ['1']]) {
    assert.throws(() => pageOptions({ visibleThreads }), { status: 400 })
  }
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
  await automationAuthorization()
  await sharedVisibility()
  console.log('review service tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
