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
    await pool.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY)')
    await pool.query('INSERT INTO "Notes" VALUES (\'one\'), (\'two\'), (\'three\'), (\'four\')')
    let review = { id: 'one', title: 'Retain a checkpoint during rollback', namespace: 'team/specs',
      public: true, policyKnown: true, status: 'in-review', approvers: ['101'], approved: [], required: 1,
      contentHash: 'version-one', policyHash: 'policy-one', url: 'https://notes.example.test/one',
      policySnapshot: { namespace: 'team/specs', roles: {} } }
    const withTx = async task => {
      const db = await pool.connect()
      try {
        await db.query('BEGIN')
        const result = await task(db)
        await db.query('COMMIT')
        return result
      } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
    }
    let failQueue = false, refreshes = 0, unavailable = false, refreshError = false, changedInTransaction = false
    const service = createReviewReminders({ db: pool, withTx,
      loadReview: async (id, db, options = {}) => {
        if (options.refreshPolicy) {
          assert.equal(db, pool, 'remote policy reads must not use the transaction client')
          refreshes++
          if (refreshError) throw new Error('fixture policy failure')
          if (unavailable) return { ...review, policyKnown: false }
        }
        if (db && db !== pool) {
          assert.deepEqual(options.policySnapshot, review.policySnapshot)
          if (changedInTransaction) return { ...review, contentHash: 'raced-edit' }
        }
        return review
      }, recipients: async () => [{ email: 'alice@example.test', reasons: ['review-requested'] }],
      enqueue: async (source, value, recipients, db) => {
        await db.query('INSERT INTO outbox VALUES ($1,$2,$3)', [source.id, JSON.stringify(value), recipients[0].email])
        if (failQueue) throw new Error('fixture outbox failure')
      } })
    await service.migrate()
    await service.migrate()
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'existing backlog starts a fresh delay')
    assert.equal(refreshes, 0, 'a new wait requires no forced policy refresh')
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
    const beforeQueueRetry = refreshes
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'a rolled-back outbox failure waits before retrying')
    assert.equal(refreshes, beforeQueueRetry, 'failed transactions do not force a policy fetch every poll')
    await pool.query("UPDATE spec_board_review_reminders SET last_attempt_at=now()-interval '2 hours' WHERE note_id='one'")
    assert.deepEqual(await service.observe('one'), { queued: 1 }, 'rollback leaves the reminder retryable')
    const current = (await pool.query('SELECT event FROM outbox ORDER BY event->>\'reviewVersion\'')).rows
      .find(row => row.event.reviewVersion !== old.reviewVersion).event
    review = { ...review, approved: ['101'] }
    assert.deepEqual(await service.filter([{ note_id: 'one', event: current }]), [])
    assert.deepEqual(await service.observe('one'), { queued: 0 })
    assert.equal((await pool.query('SELECT * FROM spec_board_review_reminders')).rowCount, 2)
    review = { ...review, approved: [], blocked: true }
    assert.deepEqual(await service.observe('one'), { queued: 0 })
    assert.deepEqual(await service.partition([{ note_id: 'one', event: current }]),
      { visible: [], deferred: [{ note_id: 'one', event: current }], unavailable: [] }, 'a new blocker preserves already queued reminders')
    review = { ...review, blocked: false }
    assert.deepEqual(await service.partition([{ note_id: 'one', event: current }]),
      { visible: [{ note_id: 'one', event: current }], deferred: [], unavailable: [] }, 'resolution makes the queued reminder deliverable')
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'resolving a thread does not repeat a sent reminder')
    review = { ...review, contentHash: 'version-one' }
    assert.deepEqual(await service.observe('one'), { queued: 0 }, 'returning to a seen version does not repeat its reminder')

    review = { ...review, id: 'two', approvers: ['101', '102', '103'], contentHash: 'version-three' }
    const deliverable = new Set(['103'])
    const rotating = createReviewReminders({ db: pool, withTx, batchLimit: 2,
      loadReview: async () => review,
      recipients: async (source, login) => deliverable.has(login) ? [{ email: `${login}@example.test` }] : [],
      enqueue: (source, event, addresses, client) => client.query('INSERT INTO outbox VALUES ($1,$2,$3)', [source.id, JSON.stringify(event), addresses[0].email]) })
    assert.deepEqual(await rotating.observe('two'), { queued: 0 })
    await due()
    assert.deepEqual(await rotating.observe('two'), { queued: 0 })
    assert.deepEqual(await rotating.observe('two'), { queued: 1 }, 'missing addresses cannot starve a later eligible reviewer')
    assert.deepEqual((await pool.query('SELECT email FROM outbox WHERE note_id=\'two\'')).rows.map(row => row.email), ['103@example.test'])
    deliverable.add('101')
    await pool.query("UPDATE spec_board_review_reminders SET last_attempt_at=now()-interval '2 hours' WHERE note_id='two' AND reviewer='101'")
    assert.deepEqual(await rotating.observe('two'), { queued: 1 }, 'onboarding can make an unsent reminder deliverable later')

    review = { ...review, id: 'three', approvers: ['101'], contentHash: 'version-four' }
    assert.deepEqual(await service.observe('three'), { queued: 0 })
    await due()
    unavailable = true
    assert.deepEqual(await service.observe('three'), { queued: 0 })
    const failedRefreshes = refreshes
    assert.deepEqual(await service.observe('three'), { queued: 0 })
    assert.equal(refreshes, failedRefreshes, 'an unavailable policy is retried at most hourly')
    unavailable = false
    await pool.query("UPDATE spec_board_review_reminders SET last_attempt_at=now()-interval '2 hours' WHERE note_id='three'")
    refreshError = true
    await assert.rejects(service.observe('three'), /policy failure/)
    refreshError = false
    assert.deepEqual(await service.observe('three'), { queued: 0 }, 'thrown policy failures also back off')
    await pool.query("UPDATE spec_board_review_reminders SET last_attempt_at=now()-interval '2 hours' WHERE note_id='three'")
    changedInTransaction = true
    assert.deepEqual(await service.observe('three'), { queued: 0 }, 'a changed candidate cannot consume a reminder')
    changedInTransaction = false
    assert.deepEqual(await service.observe('three'), { queued: 1 })

    const reviewThree = review
    review = { ...review, id: 'four', approvers: ['101', '102', '103'], approved: [], required: 3, contentHash: 'partial-quorum' }
    const partial = createReviewReminders({ db: pool, withTx, batchLimit: 1,
      loadReview: async (id, client, options = {}) => { if (options.refreshPolicy) refreshes++; return review },
      recipients: async (source, reviewer) => [{ email: `${reviewer}@example.test` }],
      enqueue: (source, event, addresses, client) => client.query('INSERT INTO outbox VALUES ($1,$2,$3)', [source.id, JSON.stringify(event), addresses[0].email]) })
    assert.deepEqual(await partial.observe('four'), { queued: 0 })
    review = { ...review, approved: ['101', '102'] }
    await due()
    assert.deepEqual(await partial.observe('four'), { queued: 1 }, 'approved reviewers cannot fill the claim batch ahead of pending reviewers')
    assert.deepEqual((await pool.query("SELECT email FROM outbox WHERE note_id='four'")).rows, [{ email: '103@example.test' }])
    const beforeSatisfiedRows = refreshes
    assert.deepEqual(await partial.observe('four'), { queued: 0 })
    assert.equal(refreshes, beforeSatisfiedRows, 'unqueued approval receipts cannot trigger repeated forced policy reads')

    await pool.query("UPDATE spec_board_review_reminders SET last_seen_at=now()-interval '91 days'")
    review = { ...reviewThree, approved: ['101'] }
    assert.deepEqual(await service.observe('three'), { queued: 0 })
    await service.cleanup()
    assert.deepEqual((await pool.query('SELECT DISTINCT note_id FROM spec_board_review_reminders')).rows, [{ note_id: 'three' }],
      'obsolete versions expire while the active version keeps its delivery receipt')
    review = { ...review, approved: [] }
    assert.deepEqual(await service.observe('three'), { queued: 0 }, 'retention does not repeat an active version reminder')
    await pool.query('DELETE FROM "Notes" WHERE shortid=\'three\'')
    assert.equal(await service.cleanup(), 1, 'deleted notes lose reminder records on the next cleanup')
    assert.equal((await pool.query('SELECT * FROM spec_board_review_reminders')).rowCount, 0)
    console.log('review reminder persistence: delay, concurrent claims, stale delivery and atomic outbox passed')
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
