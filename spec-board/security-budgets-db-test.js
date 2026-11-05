const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { migrateModelBudget, reserveModelBudget } = require('./model-budget')
const { migrateNotifications, insertNotifications } = require('./notification-store')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) throw new Error('AUDIT_TEST_DATABASE_URL must identify a disposable test database')

async function main () {
  const schema = 'security_budgets_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 })
    await migrateModelBudget(db)
    const config = { globalCalls: 10, projectCalls: 5, globalTokens: 10000, projectTokens: 5000, cooldownSeconds: 60 }
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveModelBudget(db, ['team/specs'], 100, { key: `note:${i}`, config })))
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 5, 'concurrent requests cannot overrun the durable quota')
    const usage = (await db.query('SELECT scope,calls,tokens FROM spec_board_model_budget ORDER BY scope')).rows
    assert.deepEqual(usage.map(r => [r.calls, Number(r.tokens)]), [[5, 500], [5, 500]])
    await reserveModelBudget(db, ['other/specs'], 100, { key: 'other-note', config })
    await assert.rejects(reserveModelBudget(db, ['other/specs'], 100, { key: 'other-note', config }), /cooling down/)
    await assert.rejects(reserveModelBudget(db, ['other/specs'], 5001, { config }), /budget exhausted/)
    await assert.rejects(reserveModelBudget(db, [], 100, { config }), /project scope/)
    await assert.rejects(reserveModelBudget(db, ['other/specs'], 100, { config: { ...config, disabled: true } }), /disabled/)
    await db.query('CREATE TABLE spec_board_state (note_id text PRIMARY KEY)')
    await db.query(`CREATE TABLE spec_board_notifications (id serial PRIMARY KEY, email text NOT NULL,
      note_id text NOT NULL,title text,line text NOT NULL,created_at timestamptz DEFAULT now(),attempts integer DEFAULT 0)`)
    await migrateNotifications(db)
    const spec = { id: 'note', namespace: 'team/specs', title: 'Title', url: 'https://board.test/note' }
    const recipients = [{ email: 'one@example.test', reasons: ['watch'] }]
    await Promise.all(Array.from({ length: 12 }, () => insertNotifications(db, spec, ['same event'], recipients)))
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 1, 'concurrent duplicates coalesce')
    await Promise.all(Array.from({ length: 30 }, (_, i) => insertNotifications(db, spec, Array.from({ length: 10 }, (_, j) => `event ${i} ${j}`), recipients)))
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 200, 'recipient capacity holds under concurrent inserts')
    await db.query('DELETE FROM spec_board_notifications')
    await insertNotifications(db, spec, ['after drain'], recipients)
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 0, 'daily budget survives delivery/deletion')
    console.log('security budgets: concurrent quota, cooldown, deduplication and backpressure passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
