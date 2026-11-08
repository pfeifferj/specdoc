const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createReviewStore, assertPublicationLock } = require('./review-store')
const { createReviewService } = require('./review-service')

const connectionString = process.env.REVIEW_TEST_DATABASE_URL
if (!connectionString) { console.error('Set REVIEW_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
const identity = (subject, login) => ({ provider: 'github', subject, login })
const alice = identity('1', 'alice'), bob = identity('2', 'bob'), owner = identity('3', 'owner'), approver = identity('4', 'approver')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function sharedDiscussions (pool, store, loadSource) {
  const bodyA = 'FR-001: Keep the source string unchanged.'
  const bodyB = 'FR-002: Convert the source string before use.'
  await pool.query(`INSERT INTO "Notes" VALUES ('shared-a','team/specs','editable','3',$1),
    ('shared-b','team/specs','editable','3',$2)`, [bodyA, bodyB])
  const hash = text => crypto.createHash('sha256').update(text).digest('hex')
  const finding = (producer = 'spec-review', occurrence = 'first') => ({
    actor: { kind: 'automation', id: 'review-bot', login: 'Review bot' },
    producer, kind: 'conflict', body: 'These requirements disagree about conversion.',
    evidence: [{ noteId: 'shared-a', contentHash: hash(bodyA), body: bodyA, quote: 'Keep the source string unchanged.' },
      { noteId: 'shared-b', contentHash: hash(bodyB), body: bodyB, quote: 'Convert the source string before use.' }],
    occurrenceKey: hash(occurrence), settingsFingerprint: hash('configured model settings')
  })
  let deniedNote = null
  const admin = identity('9', 'admin')
  const events = []
  const service = createReviewService({ store, loadSource,
    authorizeAutomation: async ({ actor, source }) => actor.id === 'review-bot' && source.namespace === 'team/specs',
    authorize: async ({ actor, source, recovery }) => recovery ? actor.subject === admin.subject : source.id !== deniedNote,
    notify: async event => events.push(event)
  })
  const act = (noteId, action, payload, actor = owner) => service.act(noteId, actor, action, { requestId: crypto.randomUUID(), ...payload })
  const locked = deferred(), unlock = deferred()
  const publishing = store.withPublicationLock('shared-b', async () => { locked.resolve(); await unlock.promise })
  await locked.promise
  await assert.rejects(service.recordFinding(finding()), { code: 'review-busy' }, 'either note publication locks both-source writes')
  unlock.resolve()
  await publishing
  const first = await service.recordFinding(finding())
  assert.deepEqual(first.noteIds, ['shared-a', 'shared-b'])
  assert.equal(await store.openCount('shared-a'), 1)
  assert.equal(await store.openCount('shared-b'), 1)
  assert.equal(events.length, 1)
  assert.equal(events[0].actor.kind, 'automation')
  await store.recordApproval(pool, { noteId: 'shared-b', actor: approver, action: 'approve', bodyHash: hash(bodyB) })
  const activityPage = await service.read('shared-b', { activityLimit: 1 })
  assert.equal(activityPage.activity[0].action, 'finding')
  const activityNext = await service.read('shared-b', { activityAfter: activityPage.nextActivityCursor })
  assert.deepEqual(activityNext.activity.map(event => event.action), ['approve'])
  assert.deepEqual((await service.read('shared-a')).activity.map(event => event.action), ['finding'],
    'shared thread events appear on both notes while approvals stay on their own note')
  const a = await service.read('shared-a'), b = await service.read('shared-b')
  assert.equal(a.threads[0].id, b.threads[0].id)
  assert.deepEqual(a.threads[0].messages, b.threads[0].messages)
  assert.equal(a.threads[0].starter.kind, 'automation')
  assert.equal(a.threads[0].messages[0].actor.kind, 'automation')
  assert.deepEqual((await service.read('shared-b', { visibleThreads: first.threadId })).restrictedThreadIds, [])
  assert.equal(a.threads[0].evidence[0].body, undefined, 'normal DTOs never contain full source snapshots')
  assert.equal((await service.evidence('shared-b', first.threadId, 'shared-a')).body, bodyA)
  const replay = await service.recordFinding(finding())
  assert.equal(replay.replayed, true)
  assert.equal(replay.version, first.version)
  assert.equal(events.length, 1)
  const checkpoint = await service.recordFinding(finding('checkpoint'))
  assert.equal(checkpoint.threadId, first.threadId)
  assert.equal(checkpoint.version, first.version, 'another producer does not invalidate a human discussion version')
  assert.equal(events.length, 1, 'repeated findings do not send another notification')
  assert.deepEqual((await service.read('shared-a')).threads[0].occurrenceKinds, ['checkpoint', 'spec-review'])
  assert.equal((await service.read('shared-b')).threads[0].messages.length, 1)
  const beforeReplyA = await store.status('shared-a'), beforeReplyB = await store.status('shared-b')
  const replies = await Promise.allSettled(['shared-a', 'shared-b'].map((noteId, i) =>
    act(noteId, 'reply', { threadId: first.threadId, version: checkpoint.version, body: 'Please retain the original input.' }, i ? alice : owner)))
  assert.equal(replies.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(replies.find(item => item.status === 'rejected').reason.status, 409)
  assert.notEqual((await store.status('shared-a')).fingerprint, beforeReplyA.fingerprint)
  assert.notEqual((await store.status('shared-b')).fingerprint, beforeReplyB.fingerprint)
  let current = (await service.read('shared-b')).threads[0]
  await store.withPublicationLock('shared-a', () => assert.rejects(
    act('shared-b', 'resolve', { threadId: first.threadId, version: current.version }), { code: 'review-busy' },
    'publication of the peer blocks a human resolution from either panel'))
  deniedNote = 'shared-a'
  await assert.rejects(act('shared-b', 'resolve', { threadId: first.threadId, version: current.version }), { status: 403 })
  deniedNote = null
  await act('shared-b', 'resolve', { threadId: first.threadId, version: current.version })
  assert.equal(await store.openCount('shared-a'), 0)
  assert.equal(await store.openCount('shared-b'), 0)
  const resolvedThread = (await service.read('shared-b')).threads[0]
  const resolvedStatus = await store.status('shared-b')
  const notificationsBeforeRepeat = events.length
  const occurrence = await service.recordFinding(finding('spec-review', 'another run'))
  assert.equal(occurrence.resolved, true, 'new occurrences do not undo human resolution')
  assert.equal(occurrence.version, resolvedThread.version)
  assert.deepEqual(await store.status('shared-b'), resolvedStatus, 'audit-only repeats do not invalidate summaries')
  assert.equal(events.length, notificationsBeforeRepeat, 'resolved finding repeats stay quiet')
  const occurrences = (await pool.query('SELECT evidence,settings_fingerprint FROM spec_board_review_occurrences WHERE thread_id=$1', [first.threadId])).rows
  assert.equal(occurrences.length, 3)
  for (const row of occurrences) {
    assert.equal(row.settings_fingerprint, hash('configured model settings'))
    assert.deepEqual(row.evidence.map(item => item.noteId), ['shared-a', 'shared-b'])
    assert.ok(row.evidence.every(item => !Object.hasOwn(item, 'body') && item.contentHash && item.quote))
  }
  assert.equal((await service.recordFinding(finding())).resolved, true, 'old delivery retries do not undo human resolution')
  assert.equal((await service.read('shared-a')).threads[0].resolvedBy.subject, owner.subject)
  await pool.query('UPDATE "Notes" SET content=$1 WHERE shortid=\'shared-a\'', [bodyA + '\n\nA separate clause.'])
  await assert.rejects(service.recordFinding(finding('checkpoint', 'stale')), { code: 'review-source-changed' })
  assert.equal((await service.read('shared-b')).threads[0].evidenceStale, true)
  assert.equal((await service.evidence('shared-a', first.threadId, 'shared-a')).body, bodyA, 'old evidence remains immutable')
  await pool.query('UPDATE "Notes" SET content=$1 WHERE shortid=\'shared-a\'', [bodyA])
  current = (await service.read('shared-a')).threads[0]
  await act('shared-a', 'reopen', { threadId: first.threadId, version: current.version })
  current = (await service.read('shared-b')).threads[0]
  await pool.query('UPDATE "Notes" SET permission=\'private\' WHERE shortid=\'shared-a\'')
  const restricted = await service.read('shared-b')
  assert.equal(restricted.openDiscussions, 1)
  assert.equal(restricted.threads[0].restricted, true)
  assert.deepEqual(restricted.threads[0].messages, [])
  for (const hidden of ['shared-a', 'Review bot', 'conversion', bodyA, 'Keep the source string', 'automation:review-bot']) {
    assert.ok(!JSON.stringify(restricted).includes(hidden), `restricted DTO leaked ${hidden}`)
  }
  assert.deepEqual(restricted.activity.map(event => event.action), ['approve'], 'only this note\'s own approval remains public')
  const cached = await service.read('shared-b', { after: first.threadId, visibleThreads: first.threadId + ',999999' })
  assert.deepEqual(cached.threads, [])
  assert.deepEqual(cached.restrictedThreadIds, [first.threadId, '999999'], 'off-page cached threads are invalidated without revealing unrelated IDs')
  assert.deepEqual(cached.visibleThreadStates, [{ id: first.threadId, version: current.version, resolved: false, restricted: true }],
    'off-page state reveals no source identities or unrelated thread existence')
  assert.equal(cached.visibilityChecks, undefined)
  const hiddenContext = await service.context('shared-b')
  assert.deepEqual(hiddenContext.threads, [])
  assert.equal(hiddenContext.complete, true)
  await assert.rejects(service.evidence('shared-b', first.threadId, 'shared-b'), { code: 'review-context-restricted' })
  await assert.rejects(act('shared-b', 'resolve', { threadId: first.threadId, version: current.version }), { status: 409, code: 'review-context-restricted' })
  await assert.rejects(act('shared-b', 'resolve', { threadId: first.threadId, version: current.version, recover: true }), { status: 403 })
  const recovered = await act('shared-b', 'resolve', { threadId: first.threadId, version: current.version, recover: true }, admin)
  assert.equal(recovered.recovery, true)
  assert.equal(await store.openCount('shared-b'), 0)
  const recoveredContext = await service.context('shared-b')
  assert.deepEqual(recoveredContext.threads, [])
  assert.notEqual(recoveredContext.fingerprint, hiddenContext.fingerprint)
  const recoveredState = await service.read('shared-b', { after: first.threadId, visibleThreads: first.threadId + ',999999' })
  assert.deepEqual(recoveredState.visibleThreadStates, [{ id: first.threadId, version: recovered.version, resolved: true, restricted: true }])
  await pool.query('UPDATE "Notes" SET permission=\'editable\' WHERE shortid=\'shared-a\'')
  const restoredState = await service.read('shared-b', { after: first.threadId, visibleThreads: first.threadId })
  assert.deepEqual(restoredState.visibleThreadStates, [{ id: first.threadId, version: recovered.version, resolved: true, restricted: false }])
  await pool.query('UPDATE "Notes" SET permission=\'private\' WHERE shortid=\'shared-a\'')
  assert.equal((await pool.query('SELECT action FROM spec_board_review_events WHERE id=$1', [recovered.eventId])).rows[0].action, 'recover')
  await store.migrate()
  await pool.query('DELETE FROM "Notes" WHERE shortid=\'shared-a\'')
  await store.cleanup()
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_messages WHERE thread_id=$1', [first.threadId])).rows[0].n, 2,
    'deleting the canonical owner note must retain another note\'s shared history')
  assert.equal((await service.read('shared-b')).threads[0].restricted, true)
  await pool.query('DELETE FROM "Notes" WHERE shortid=\'shared-b\'')
  await store.cleanup()
  for (const table of ['messages', 'events', 'thread_notes', 'occurrences']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM spec_board_review_${table} WHERE thread_id=$1`, [first.threadId])).rows[0].n, 0)
  }
  assert.equal((await pool.query('SELECT 1 FROM spec_board_review_threads WHERE id=$1', [first.threadId])).rowCount, 0)
}

async function main () {
  const schema = 'review_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let pool
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
    await pool.query(`CREATE TABLE "Notes" (shortid text PRIMARY KEY, namespace text,
      permission text, owner_subject text, content text)`)
    await pool.query(`INSERT INTO "Notes" VALUES ('one','team/specs','editable','3','Requirements.'),
      ('two','team/specs','editable','3','Other requirements.')`)
    await pool.query('CREATE TABLE saved_approvals (note_id text, actor_subject text, PRIMARY KEY (note_id, actor_subject))')
    const store = createReviewStore(pool)
    await require('./moderation').migrateModeration(pool)
    await store.migrate()
    await store.migrate()
    const notifications = []
    const loadSource = async (noteId, db = pool, { lock } = {}) => {
      const { rows: [row] } = await db.query(`SELECT * FROM "Notes" WHERE shortid=$1 ${lock ? 'FOR UPDATE' : ''}`, [noteId])
      return row && { id: row.shortid, namespace: row.namespace, permission: row.permission, ownerSubject: row.owner_subject, content: row.content }
    }
    await sharedDiscussions(pool, store, loadSource)
    const service = createReviewService({ store, loadSource,
      authorize: async ({ actor, action, source, thread }) => !['resolve', 'reopen'].includes(action) ||
        [thread.starter.subject, source.ownerSubject, approver.subject].includes(actor.subject),
      notify: async event => notifications.push(event)
    })
    const act = (actor, action, payload, noteId = 'one') => service.act(noteId, actor, action, { requestId: crypto.randomUUID(), ...payload })
    const approvalAction = async (actor, action, requestId) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT 1 FROM "Notes" WHERE shortid=\'two\' FOR UPDATE')
        const event = { noteId: 'two', actor, action, requestId }
        const previous = await store.readApprovalReceipt(client, event)
        if (previous) {
          await client.query('COMMIT')
          return { ...previous, replayed: true }
        }
        const applied = action === 'approve'
          ? await client.query('INSERT INTO saved_approvals VALUES (\'two\',$1) ON CONFLICT DO NOTHING', [actor.subject])
          : await client.query('DELETE FROM saved_approvals WHERE note_id=\'two\' AND actor_subject=$1', [actor.subject])
        if (applied.rowCount) await store.recordApproval(client, { ...event, bodyHash: 'b'.repeat(64) })
        const result = { changed: applied.rowCount > 0, approved: action === 'approve' }
        await store.saveApprovalReceipt(client, event, result)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    }
    const approveA = 'a'.repeat(64), retractB = 'b'.repeat(64), noOp = 'c'.repeat(64), approveC = 'd'.repeat(64)
    await approvalAction(alice, 'approve', approveA)
    await approvalAction(alice, 'retract', retractB)
    assert.equal((await approvalAction(alice, 'approve', approveA)).replayed, true)
    assert.equal((await pool.query('SELECT 1 FROM saved_approvals WHERE actor_subject=$1', [alice.subject])).rowCount, 0,
      'replaying an old approval does not resurrect it after retraction')
    const eventsBeforeNoOp = (await service.read('two')).activity.length
    assert.equal((await approvalAction(bob, 'retract', noOp)).changed, false)
    assert.equal((await service.read('two')).activity.length, eventsBeforeNoOp,
      'a no-op retraction gets a receipt without inventing a history event')
    await approvalAction(bob, 'approve', approveC)
    assert.equal((await approvalAction(bob, 'retract', noOp)).replayed, true)
    assert.equal((await pool.query('SELECT 1 FROM saved_approvals WHERE actor_subject=$1', [bob.subject])).rowCount, 1,
      'replaying a no-op retraction cannot remove a later approval')
    await assert.rejects(approvalAction(alice, 'retract', approveA), { status: 409 })
    await service.act('two', alice, 'thread', { requestId: approveA, body: 'A separate discussion request with the same external ID.' })
    assert.equal((await approvalAction(alice, 'approve', approveA)).replayed, true,
      'approval and general-discussion request IDs have separate purposes')
    assert.equal((await service.read('one')).activity.length, 0, 'missing history is not reconstructed')
    const first = await act(alice, 'thread', { body: 'What happens during rollback?' })
    assert.equal(first.version, 1)
    assert.equal(await store.openCount('one'), 1)
    const replyPayload = { requestId: crypto.randomUUID(), threadId: first.threadId, version: 1, body: 'Does a failed rollback retain the checkpoint?' }
    const reply = await service.act('one', bob, 'reply', replyPayload)
    assert.equal(reply.version, 2)
    assert.equal((await service.act('one', bob, 'reply', replyPayload)).replayed, true)
    assert.equal(notifications.filter(event => event.noteId === 'one').length, 2)
    await assert.rejects(service.act('one', bob, 'reply', { ...replyPayload, body: 'Changed replay' }), { status: 409 })
    await assert.rejects(act(bob, 'resolve', { threadId: first.threadId, version: 2 }), { status: 403 })
    await assert.rejects(act(alice, 'reply', { threadId: first.threadId, version: 1, body: 'Stale answer' }), { status: 409 })
    await assert.rejects(act(alice, 'reply', { threadId: first.threadId, version: 2, body: 'Wrong note' }, 'two'), { status: 404 })
    const resolved = await act(owner, 'resolve', { threadId: first.threadId, version: 2 })
    assert.equal(resolved.version, 3)
    await assert.rejects(act(alice, 'reply', { threadId: first.threadId, version: 3, body: 'Too late' }), { status: 409 })
    const reopened = await act(approver, 'reopen', { threadId: first.threadId, version: 3 })
    assert.equal(reopened.version, 4)
    const race = await Promise.allSettled([
      act(alice, 'reply', { threadId: first.threadId, version: 4, body: 'First answer' }),
      act(bob, 'reply', { threadId: first.threadId, version: 4, body: 'Competing answer' })
    ])
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(race.find(result => result.status === 'rejected').reason.status, 409)
    let page = await service.read('one', { messageLimit: 2 })
    assert.equal(page.threads[0].starter.subject, alice.subject)
    assert.equal(page.threads[0].messages.length, 2)
    assert.ok(page.threads[0].nextMessageCursor)
    const replies = await service.read('one', { threadId: first.threadId, messageAfter: page.threads[0].nextMessageCursor })
    assert.equal(replies.threads[0].messages.length, 1)
    const beforeApproval = await store.status('one')
    const client = await pool.connect()
    let approval
    try {
      await client.query('BEGIN')
      approval = await store.recordApproval(client, { noteId: 'one', actor: approver, action: 'approve', bodyHash: 'a'.repeat(64), requestId: 'approval-request-0001' })
      assert.equal((await store.recordApproval(client, { noteId: 'one', actor: approver, action: 'approve', bodyHash: 'a'.repeat(64), requestId: 'approval-request-0001' })).id, approval.id)
      await client.query('COMMIT')
      await client.query('BEGIN')
      await assert.rejects(store.recordApproval(client, { noteId: 'one', actor: approver, action: 'retract', requestId: 'approval-request-0001' }), { status: 409 })
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await store.recordApproval(client, { noteId: 'one', actor: approver, action: 'retract', bodyHash: 'a'.repeat(64) })
      await store.recordRoundEnded(client, { noteId: 'one', bodyHash: 'a'.repeat(64) })
      await client.query('ROLLBACK')
    } finally { client.release() }
    page = await service.read('one', { activityLimit: 2 })
    assert.equal(page.activity.length, 2)
    assert.ok(page.nextActivityCursor)
    const history = await service.read('one', { activityAfter: page.nextActivityCursor })
    assert.equal(history.activity.at(-1).action, 'approve')
    assert.equal(history.activity.filter(event => event.action === 'retract').length, 0)
    assert.equal(history.activity.filter(event => event.action === 'approval-round-ended').length, 0,
      'a rolled-back review reset cannot leave a historical marker')
    const round = await store.recordRoundEnded(pool, { noteId: 'one', bodyHash: 'a'.repeat(64) })
    const labelled = await store.recordApproval(pool, { noteId: 'two', actor: identity('5', 'legacy-'), action: 'approve', bodyHash: 'a'.repeat(64) })
    assert.equal(labelled.actor.login, 'legacy-', 'the stored display label accepts the signed editor format')
    assert.deepEqual(round.actor, { subject: '0', login: 'SpecDoc' })
    assert.equal((await service.read('one')).activity.at(-1).action, 'approval-round-ended')
    assert.notEqual(page.fingerprint, beforeApproval.fingerprint)
    const second = await act(bob, 'thread', { body: 'What is the recovery deadline?' })
    const third = await act(alice, 'thread', { body: 'Which observer is authoritative?' })
    const threadsPage = await service.read('one', { limit: 2 })
    assert.equal(threadsPage.threads.length, 2)
    assert.ok(threadsPage.nextCursor)
    assert.equal((await service.read('one', { after: threadsPage.nextCursor })).threads[0].id, third.threadId)
    await assert.rejects(service.context('one', { maxMessages: 2 }), { code: 'review-context-incomplete' })
    await assert.rejects(service.context('one', { maxThreads: 2 }), { code: 'review-context-incomplete' })
    await assert.rejects(service.context('one', { maxBytes: 100 }), { code: 'review-context-incomplete' })
    assert.equal((await service.context('one')).complete, true)
    assert.equal((await service.context('one')).threads.length, 3)
    const visibleMessages = (await service.context('one')).threads.flatMap(thread => thread.messages)
    await pool.query("INSERT INTO spec_board_moderation_accounts(provider,subject,state,actor,reason) VALUES('github','1','suspended','3','Reported message')")
    for (const view of [await service.read('one'), await service.context('one')]) {
      const messages = view.threads.flatMap(thread => thread.messages)
      assert.ok(messages.some(message => message.hidden))
      assert.ok(messages.filter(message => message.actor.subject === '1').every(message => message.body === '[Message hidden because its author is suspended.]'))
      for (const hidden of visibleMessages.filter(message => message.actor.subject === '1')) {
        assert.ok(!JSON.stringify(view).includes(hidden.body), 'suspended messages leave public and model context immediately')
      }
    }
    await pool.query("UPDATE spec_board_moderation_accounts SET state='active' WHERE subject='1'")
    assert.deepEqual((await service.context('one')).threads.flatMap(thread => thread.messages), visibleMessages,
      'reversing a suspension restores retained messages')
    let publishes = 0
    for (const thread of (await service.read('one')).threads) {
      await act(owner, 'resolve', { threadId: thread.id, version: thread.version })
    }
    const entered = deferred(), release = deferred()
    const publication = store.withPublicationLock('one', async () => { entered.resolve(); await release.promise; return 'published' })
    await entered.promise
    await assert.rejects(act(alice, 'thread', { body: 'Concurrent question' }), { code: 'review-busy' })
    release.resolve()
    assert.equal(await publication, 'published')
    const intentCommitted = deferred(), remoteCompleted = deferred()
    const submitted = store.withPublicationLock('one', async () => {
      intentCommitted.resolve()
      await remoteCompleted.promise
      return 'submitted'
    })
    await intentCommitted.promise
    await assert.rejects(act(alice, 'thread', { body: 'A blocker after intent commit' }), { code: 'review-busy' })
    remoteCompleted.resolve()
    assert.equal(await submitted, 'submitted', 'the session lock lasts until the external publication completes')
    const mutating = deferred(), finishMutation = deferred()
    const pending = store.mutate({ noteId: 'one', actor: alice, action: 'thread', payload: { body: 'New question', requestId: crypto.randomUUID() }, requestHash: 'h',
      validate: async db => { await loadSource('one', db, { lock: true }); mutating.resolve(); await finishMutation.promise } })
    await mutating.promise
    await assert.rejects(store.withPublicationLock('one', async () => { publishes++ }), { code: 'review-busy' })
    finishMutation.resolve()
    await pending
    assert.equal(publishes, 0)
    const limited = identity('99', 'limited')
    let lockConnection
    pool.once('acquire', client => { lockConnection = client })
    await assert.rejects(store.withPublicationLock('connection-loss', async ({ signal }) => {
      const { rows: [backend] } = await lockConnection.query('SELECT pg_backend_pid() AS pid')
      const disconnected = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      await admin.query('SELECT pg_terminate_backend($1)', [backend.pid])
      await disconnected
      assert.throws(assertPublicationLock, { code: 'review-busy' }, 'subsequent outbound writes stop when the lock connection dies')
    }), { code: 'review-busy' })
    await store.withPublicationLock('connection-loss', async () => assertPublicationLock())
    const rejected = identity('98', 'rejected')
    let preparations = 0
    const rejecting = createReviewService({ store, loadSource,
      prepareAuthorize: async () => { preparations++ }, authorize: async () => false })
    await assert.rejects(rejecting.act('one', rejected, 'thread', { body: 'Not permitted', requestId: crypto.randomUUID() }), { status: 403 })
    assert.equal((await pool.query('SELECT attempts FROM spec_board_review_attempt_budget WHERE actor_subject=$1', [rejected.subject])).rows[0].attempts, 1,
      'a rejected mutation cannot roll back its admission charge')
    await pool.query('UPDATE spec_board_review_attempt_budget SET attempts=60 WHERE actor_subject=$1', [rejected.subject])
    await assert.rejects(rejecting.act('one', rejected, 'thread', { body: 'Not permitted', requestId: crypto.randomUUID() }), { status: 429 })
    assert.equal(preparations, 1, 'exhausted attempts cannot reach remote policy preparation')
    await pool.query("UPDATE spec_board_review_attempt_budget SET started_at=now()-interval '2 minutes' WHERE actor_subject=$1", [rejected.subject])
    await assert.rejects(rejecting.act('one', rejected, 'thread', { body: 'Not permitted', requestId: crypto.randomUUID() }), { status: 403 })
    assert.equal(preparations, 2, 'the attempt budget admits another permission check after its window ends')
    assert.equal((await pool.query('SELECT attempts FROM spec_board_review_attempt_budget WHERE actor_subject=$1', [rejected.subject])).rows[0].attempts, 1)
    const limitedPayload = { requestId: crypto.randomUUID(), body: 'A request with a recoverable receipt.' }
    const receipt = await service.act('two', limited, 'thread', limitedPayload)
    await pool.query('UPDATE spec_board_review_actor_budget SET actions=29 WHERE actor_subject=$1', [limited.subject])
    const allowanceRace = await Promise.allSettled([
      act(limited, 'thread', { body: 'Last allowed action in one note.' }),
      act(limited, 'thread', { body: 'Last allowed action in another note.' }, 'two')
    ])
    assert.equal(allowanceRace.filter(result => result.status === 'fulfilled').length, 1,
      'one account cannot race its allowance through separate notes')
    assert.equal((await service.act('two', limited, 'thread', limitedPayload)).eventId, receipt.eventId,
      'a valid replay remains available after the allowance is exhausted')
    await assert.rejects(act(limited, 'thread', { body: 'Beyond the allowance.' }, 'two'), { code: 'review-rate-limit' })
    await pool.query('UPDATE "Notes" SET permission=\'private\' WHERE shortid=\'one\'')
    await assert.rejects(service.read('one'), { status: 404 })
    await assert.rejects(act(alice, 'thread', { body: 'Hidden question' }), { status: 404 })
    const privateCounts = (await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_threads WHERE note_id=\'one\'')).rows[0].n
    await store.cleanup()
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_threads WHERE note_id=\'one\'')).rows[0].n, privateCounts,
      'cleanup retains discussion on an existing private note')
    await pool.query('DELETE FROM "Notes" WHERE shortid=\'one\'')
    await assert.rejects(service.context('one'), { status: 404 })
    const gateEntered = deferred(), gateRelease = deferred()
    const held = store.withPublicationLock('absent', async () => {
      await pool.query(`INSERT INTO spec_board_review_events (note_id,actor_subject,actor_login,action)
        VALUES ('absent','1','alice','approve')`)
      gateEntered.resolve()
      await gateRelease.promise
    })
    await gateEntered.promise
    const cleaned = await store.cleanup()
    assert.equal(cleaned.notes, 1)
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_threads WHERE note_id=\'one\'')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_requests WHERE note_id=\'one\'')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_review_events WHERE note_id=\'absent\'')).rows[0].n, 1,
      'cleanup skips a note while its publication gate is held')
    gateRelease.resolve()
    await held
    assert.equal((await store.cleanup()).notes, 1)
    await assert.rejects(act(limited, 'thread', { body: 'Deleting a note cannot reset the allowance.' }, 'two'), { code: 'review-rate-limit' })
    assert.ok((await service.read('two')).threads.length > 0)
    await pool.query('UPDATE spec_board_review_actor_budget SET started_at=now()-interval \'2 minutes\' WHERE actor_subject=$1', [limited.subject])
    await act(limited, 'thread', { body: 'A fresh allowance after a minute.' }, 'two')
    assert.equal(second.resolved, false)
    console.log('review store database tests passed')
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
