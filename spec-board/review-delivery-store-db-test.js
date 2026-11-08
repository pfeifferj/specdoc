const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { createReviewDeliveryStore } = require('./review-delivery-store')

const connectionString = process.env.REVIEW_TEST_DATABASE_URL
if (!connectionString) throw new Error('Set REVIEW_TEST_DATABASE_URL to an explicit disposable PostgreSQL test database.')

async function waitForLock (db, pid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows: [row] } = await db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])
    if (row.blocked) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('The concurrent cleanup did not reach its row lock')
}

async function main () {
  const schema = 'review_delivery_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 })
    await db.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY)')
    await db.query('CREATE TABLE spec_board_bots (name text PRIMARY KEY)')
    await db.query(`CREATE TABLE spec_board_reviews (
      note_id text NOT NULL,bot_name text NOT NULL,reviewed_hash text NOT NULL,delivery jsonb,
      PRIMARY KEY(note_id,bot_name))`)
    await db.query("INSERT INTO spec_board_bots VALUES ('reviewer'),('disabled-bot'),('other-bot'),('deleted-bot')")
    const now = Date.now()
    const note = async id => { await db.query('INSERT INTO "Notes" VALUES ($1) ON CONFLICT DO NOTHING', [id]) }
    const payload = (id, extra = {}) => ({ id: crypto.randomUUID(), state: 'pending', namespace: 'team/specs',
      noteIds: [id], retryAt: now + 60000, expiresAt: now + 86400000,
      mutation: { operationId: crypto.randomUUID(), content: 'Saved inline text' },
      findings: [{ findingKey: 'first', evidence: 'Frozen source text' }, { findingKey: 'second' }], ...extra })
    const store = createReviewDeliveryStore(db)
    await note('recover')
    const original = payload('recover')
    let loseReply = true
    const interrupted = createReviewDeliveryStore({ query: async (sql, values) => {
      const result = await db.query(sql, values)
      if (loseReply && sql.startsWith('INSERT')) { loseReply = false; throw new Error('Database acknowledgement lost') }
      return result
    } })
    await assert.rejects(interrupted.saveNew('recover', 'reviewer', 'hash-a', original), /acknowledgement lost/)
    const recovered = await store.saveNew('recover', 'reviewer', 'hash-a', payload('recover'))
    assert.deepEqual(recovered, { reviewed_hash: 'hash-a', delivery: original }, 'a retry adopts the stored operation and response')
    const partial = { ...original, findings: original.findings.slice(1), attempts: 1, retryAt: now + 120000 }
    assert.equal(await store.update('recover', 'reviewer', 'hash-a', original.id, partial), true)
    const reloaded = createReviewDeliveryStore(db)
    assert.deepEqual(await reloaded.read('recover', 'reviewer'), { reviewed_hash: 'hash-a', delivery: partial })
    assert.equal(await reloaded.update('recover', 'reviewer', 'hash-a', 'another-run', null), false)
    assert.equal(await reloaded.update('recover', 'reviewer', 'hash-a', original.id, null), true)
    assert.deepEqual(await reloaded.saveNew('recover', 'reviewer', 'hash-a', payload('recover')),
      { reviewed_hash: 'hash-a', delivery: null }, 'an acknowledged response cannot be regenerated after delivery completed')
    assert.equal(await reloaded.update('recover', 'reviewer', 'hash-a', original.id, partial), false,
      'a delayed update cannot resurrect completed delivery')

    await note('terminal')
    const pending = payload('terminal')
    const tombstone = { id: pending.id, state: 'failed', reason: 'expired' }
    await store.saveNew('terminal', 'reviewer', 'hash-terminal', pending)
    assert.equal(await store.update('terminal', 'reviewer', 'hash-terminal', pending.id, tombstone), true)
    assert.equal(await store.update('terminal', 'reviewer', 'hash-terminal', pending.id, pending), false,
      'a paused delivery cannot restore source text after cleanup kept its run ID')
    assert.deepEqual(await store.read('terminal', 'reviewer'), { reviewed_hash: 'hash-terminal', delivery: tombstone })
    assert.deepEqual(await store.saveNew('terminal', 'reviewer', 'hash-terminal', pending),
      { reviewed_hash: 'hash-terminal', delivery: tombstone }, 'same-hash recovery preserves the content-free outcome')

    const replacement = payload('recover')
    assert.deepEqual(await store.saveNew('recover', 'reviewer', 'hash-b', replacement, 'hash-a'),
      { reviewed_hash: 'hash-b', delivery: replacement })
    assert.equal(await store.update('recover', 'reviewer', 'hash-a', original.id, null), false)
    assert.equal(await store.saveNew('recover', 'reviewer', 'hash-c', payload('recover'), 'hash-a'), null)
    assert.deepEqual(await store.saveNew('recover', 'reviewer', 'hash-b', payload('recover'), 'wrong-previous'),
      { reviewed_hash: 'hash-b', delivery: replacement })

    await note('concurrent')
    const first = payload('concurrent'), second = payload('concurrent')
    const sameHash = await Promise.all([first, second].map(delivery => store.saveNew('concurrent', 'reviewer', 'initial', delivery)))
    assert.deepEqual(sameHash[0], sameHash[1], 'concurrent saves adopt one immutable generation')
    const competing = await Promise.all(['next-a', 'next-b'].map(hash =>
      store.saveNew('concurrent', 'reviewer', hash, payload('concurrent'), 'initial')))
    assert.equal(competing.filter(Boolean).length, 1, 'only one replacement can match the observed generation')
    assert.deepEqual(await store.read('concurrent', 'reviewer'), competing.find(Boolean))

    let rawMetadata
    const metadataStore = createReviewDeliveryStore({ query: async (sql, values) => {
      const result = await db.query(sql, values)
      rawMetadata = result.rows
      return result
    } })
    const listed = await metadataStore.list()
    assert.deepEqual(Object.keys(rawMetadata[0]).sort(), ['bot_name', 'delivery_state', 'note_id', 'retry_at', 'reviewed_hash'])
    assert.deepEqual(listed.find(row => row.note_id === 'recover'), {
      note_id: 'recover', bot_name: 'reviewer', reviewed_hash: 'hash-b', delivery_state: 'pending', retry_at: replacement.retryAt
    })
    assert.ok(!JSON.stringify(rawMetadata).includes('Frozen source text'), 'the metadata query does not retrieve source bodies')
    assert.ok(!JSON.stringify(rawMetadata).includes('Saved inline text'), 'the metadata query does not retrieve editor mutations')

    await db.query('DELETE FROM spec_board_reviews')
    const subjects = ['expired', 'hidden-peer', 'moved-peer', 'hidden-subject', 'disabled', 'unassigned', 'healthy', 'finished', 'failed']
    for (const id of [...subjects, 'peer', 'moved', 'removed-subject', 'removed-bot']) await note(id)
    const deliveries = new Map()
    const save = async (id, extra = {}, bot = 'reviewer') => {
      const delivery = payload(id, extra)
      deliveries.set(id, delivery)
      await store.saveNew(id, bot, 'hash-' + id, delivery)
    }
    await save('expired', { expiresAt: now })
    await save('hidden-peer', { noteIds: ['hidden-peer', 'peer'] })
    await save('moved-peer', { noteIds: ['moved-peer', 'moved'] })
    await save('hidden-subject')
    await save('disabled', {}, 'disabled-bot')
    await save('unassigned', {}, 'other-bot')
    await save('healthy')
    await store.saveNew('finished', 'reviewer', 'hash-finished', null)
    const failed = { id: crypto.randomUUID(), state: 'failed', reason: 'editor-unavailable' }
    await store.saveNew('failed', 'reviewer', 'hash-failed', failed)
    await save('removed-subject')
    await save('removed-bot', {}, 'deleted-bot')
    await db.query('DELETE FROM "Notes" WHERE shortid=$1', ['removed-subject'])
    await db.query('DELETE FROM spec_board_bots WHERE name=$1', ['deleted-bot'])
    const activeNotes = subjects.filter(id => id !== 'hidden-subject').map(id => ({ id, namespace: 'team/specs', content: 'Do not send source bodies' }))
    activeNotes.push({ id: 'moved', namespace: 'other/specs' }, { id: 'removed-bot', namespace: 'team/specs' })
    const activeBots = [
      { name: 'reviewer', namespaces: ['team/specs'], api_key: 'Do not send bot credentials' },
      { name: 'other-bot', namespaces: ['other/specs'] }
    ]
    const parameters = []
    const sweeping = createReviewDeliveryStore({ query: (sql, values) => {
      if (values) parameters.push(values)
      return db.query(sql, values)
    } })
    await sweeping.sweep(activeNotes, activeBots, now)
    for (const [id, reason, bot] of [
      ['expired', 'expired'], ['hidden-peer', 'source-unavailable'], ['moved-peer', 'source-unavailable'],
      ['hidden-subject', 'source-unavailable'], ['disabled', 'bot-unavailable', 'disabled-bot'],
      ['unassigned', 'bot-unavailable', 'other-bot']
    ]) {
      assert.deepEqual(await store.read(id, bot || 'reviewer'), { reviewed_hash: 'hash-' + id,
        delivery: { id: deliveries.get(id).id, state: 'failed', reason } }, id + ' retains only its outcome')
    }
    assert.deepEqual(await store.read('healthy', 'reviewer'), { reviewed_hash: 'hash-healthy', delivery: deliveries.get('healthy') })
    assert.deepEqual(await store.read('finished', 'reviewer'), { reviewed_hash: 'hash-finished', delivery: null })
    assert.deepEqual(await store.read('failed', 'reviewer'), { reviewed_hash: 'hash-failed', delivery: failed })
    assert.equal(await store.read('removed-subject', 'reviewer'), null)
    assert.equal(await store.read('removed-bot', 'deleted-bot'), null)
    assert.ok(!JSON.stringify(parameters).includes('Do not send'), 'sweep sends only the IDs and namespaces it needs')

    await note('cleanup-race')
    const stale = payload('cleanup-race', { expiresAt: now })
    const fresh = payload('cleanup-race')
    await store.saveNew('cleanup-race', 'reviewer', 'stale', stale)
    const holder = await db.connect(), waiter = await db.connect()
    let cleanup
    try {
      await holder.query('BEGIN')
      await holder.query("SELECT 1 FROM spec_board_reviews WHERE note_id='cleanup-race' FOR UPDATE")
      const { rows: [{ pid }] } = await waiter.query('SELECT pg_backend_pid() AS pid')
      cleanup = createReviewDeliveryStore(waiter).sweep([...activeNotes, { id: 'cleanup-race', namespace: 'team/specs' }], activeBots, now)
      await waitForLock(admin, pid)
      await holder.query("UPDATE spec_board_reviews SET reviewed_hash='fresh',delivery=$1 WHERE note_id='cleanup-race'", [JSON.stringify(fresh)])
      await holder.query('COMMIT')
      await cleanup
      assert.deepEqual(await store.read('cleanup-race', 'reviewer'), { reviewed_hash: 'fresh', delivery: fresh },
        'cleanup cannot discard a generation that replaced the one it inspected')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      if (cleanup) await cleanup.catch(() => {})
      holder.release()
      waiter.release()
    }

    await note('recreated')
    const previous = payload('recreated'), recreated = payload('recreated')
    await store.saveNew('recreated', 'reviewer', 'previous', previous)
    await db.query("DELETE FROM \"Notes\" WHERE shortid='recreated'")
    const replacing = await db.connect(), deleting = await db.connect()
    let orphanCleanup
    try {
      await replacing.query('BEGIN')
      await replacing.query("SELECT 1 FROM spec_board_reviews WHERE note_id='recreated' FOR UPDATE")
      const { rows: [{ pid }] } = await deleting.query('SELECT pg_backend_pid() AS pid')
      orphanCleanup = createReviewDeliveryStore(deleting).sweep([...activeNotes, { id: 'recreated', namespace: 'team/specs' }], activeBots, now)
      await waitForLock(admin, pid)
      await replacing.query("INSERT INTO \"Notes\" VALUES ('recreated')")
      await replacing.query("UPDATE spec_board_reviews SET reviewed_hash='recreated',delivery=$1 WHERE note_id='recreated'", [JSON.stringify(recreated)])
      await replacing.query('COMMIT')
      await orphanCleanup
      assert.deepEqual(await store.read('recreated', 'reviewer'), { reviewed_hash: 'recreated', delivery: recreated },
        'orphan cleanup cannot delete a replacement generation after its subject was recreated')
    } finally {
      await replacing.query('ROLLBACK').catch(() => {})
      if (orphanCleanup) await orphanCleanup.catch(() => {})
      replacing.release()
      deleting.release()
    }
    console.log('review delivery storage: recovery, conditional updates, cleanup and metadata reads passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
