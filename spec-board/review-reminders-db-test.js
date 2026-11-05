const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createReviewReminders, reviewVersion } = require('./review-reminders')

const connectionString = process.env.REVIEW_TEST_DATABASE_URL
if (!connectionString) { console.error('Set REVIEW_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const schema = 'review_reminders_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let pool
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
    await pool.query('CREATE TABLE outbox (note_id text, event jsonb, email text)')
    let review = { id: 'one', title: 'Retain a checkpoint during rollback', namespace: 'team/specs',
      public: true, policyKnown: true, status: 'in-review', approvers: ['alice'], approved: [], required: 1,
      contentHash: 'version-one', policyHash: 'policy-one', url: 'https://notes.example.test/one' }
    const withTx = async task => {
      const db = await pool.connect()
      try {
        await db.query('BEGIN')
        const result = await task(db)
        await db.query('COMMIT')
        return result
      } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
    }
    let failQueue = false
    const service = createReviewReminders({ db: pool, withTx,
      loadReview: async () => review, recipients: async () => [{ email: 'alice@example.test', reasons: ['review-requested'] }],
      enqueue: async (source, value, recipients, db) => {
        await db.query('INSERT INTO outbox VALUES ($1,$2,$3)', [source.id, JSON.stringify(value), recipients[0].email])
        if (failQueue) throw new Error('fixture outbox failure')
      } })
    await service.migrate()
    await service.migrate()
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'existing backlog starts a fresh delay')
    const due = () => pool.query("UPDATE spec_board_review_reminders SET first_seen_at=now()-interval '25 hours'")
    await due()
    const races = await Promise.all([service.observe('one'), service.observe('one')])
    assert.equal(races.reduce((sum, row) => sum + row.queued, 0), 1)
    assert.equal((await pool.query('SELECT * FROM outbox')).rowCount, 1)
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'a version is reminded once')
    const old = (await pool.query('SELECT event FROM outbox')).rows[0].event
    review = { ...review, contentHash: 'version-two' }
    assert.deepEqual(await service.filter([{ note_id: 'one', event: old }]), [], 'stale queued reminders disappear')
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'a changed version gets its own delay')
    await due()
    failQueue = true
    await assert.rejects(service.observe('one'), /outbox failure/)
    assert.equal((await pool.query('SELECT * FROM outbox')).rowCount, 1, 'failed outbox writes roll back')
    assert.equal((await pool.query('SELECT queued_at FROM spec_board_review_reminders WHERE version=$1', [reviewVersion(review)])).rows[0].queued_at, null)
    failQueue = false
    assert.deepEqual(await service.observe('one'), { queued: 1 }, 'rollback leaves the reminder retryable')
    const current = (await pool.query('SELECT event FROM outbox ORDER BY event->>\'reviewVersion\'')).rows
      .find(row => row.event.reviewVersion !== old.reviewVersion).event
    review = { ...review, approved: ['alice'] }
    assert.deepEqual(await service.filter([{ note_id: 'one', event: current }]), [])
    assert.deepEqual(await service.observe('one'), { queued: 0 })
    assert.equal((await pool.query('SELECT * FROM spec_board_review_reminders')).rowCount, 2)
    review = { ...review, approved: [], blocked: true }
    assert.deepEqual(await service.observe('one'), { queued: 0 })
    review = { ...review, blocked: false }
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'resolving a thread does not repeat a sent reminder')
    review = { ...review, contentHash: 'version-one' }
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'returning to a seen version does not repeat its reminder')

    review = { ...review, id: 'two', approvers: ['alice', 'bob', 'charlie'], contentHash: 'version-three' }
    const deliverable = new Set(['charlie'])
    const rotating = createReviewReminders({ db: pool, withTx, batchLimit: 2,
      loadReview: async () => review,
      recipients: async (source, login) => deliverable.has(login) ? [{ email: `${login}@example.test` }] : [],
      enqueue: (source, event, addresses, client) => client.query('INSERT INTO outbox VALUES ($1,$2,$3)', [source.id, JSON.stringify(event), addresses[0].email]) })
    assert.deepEqual(await rotating.observe('two'), { queued: 0 })
    await due()
    assert.deepEqual(await rotating.observe('two'), { queued: 0 })
    assert.deepEqual(await rotating.observe('two'), { queued: 1 }, 'missing addresses cannot starve a later eligible reviewer')
    assert.deepEqual((await pool.query('SELECT email FROM outbox WHERE note_id=\'two\'')).rows.map(row => row.email), ['charlie@example.test'])
    deliverable.add('alice')
    await pool.query("UPDATE spec_board_review_reminders SET last_attempt_at=now()-interval '2 hours' WHERE note_id='two' AND reviewer='alice'")
    assert.deepEqual(await rotating.observe('two'), { queued: 1 }, 'onboarding can make an unsent reminder deliverable later')
    console.log('review reminder persistence: delay, concurrent claims, stale delivery and atomic outbox passed')
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
