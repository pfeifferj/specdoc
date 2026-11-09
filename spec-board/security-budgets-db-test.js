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

    const reservations = attempts.filter(a => a.status === 'fulfilled').map(a => a.value)
    await Promise.all(reservations.flatMap(reservation => Array.from({ length: 3 }, () => reservation.releaseTokens())))
    const refunded = (await db.query('SELECT scope,calls,tokens FROM spec_board_model_budget ORDER BY scope')).rows
    assert.deepEqual(refunded.map(row => [row.scope, row.calls, Number(row.tokens)]), [
      ['*', 6, 100], ['other/specs', 1, 100], ['team/specs', 5, 0]
    ], 'each reservation refunds tokens once without refunding attempts or other projects')
    await assert.rejects(reserveModelBudget(db, ['team/specs'], 100, { config }), /budget exhausted/,
      'refunds do not reopen the daily call allowance')
    const cooldown = await reserveModelBudget(db, ['cooldown/specs'], 100, { key: 'refunded-note', config })
    await cooldown.releaseTokens()
    await assert.rejects(reserveModelBudget(db, ['cooldown/specs'], 100, { key: 'refunded-note', config }), /cooling down/,
      'refunding tokens does not remove the trigger cooldown')

    await db.query('TRUNCATE spec_board_model_budget, spec_board_model_cooldown')
    const pending = await Promise.all(Array.from({ length: 5 }, () => reserveModelBudget(db, ['concurrent/specs'], 100, { config })))
    await Promise.all([
      ...pending.map(reservation => reservation.releaseTokens()),
      ...Array.from({ length: 5 }, () => reserveModelBudget(db, ['another/specs'], 100, { config }))
    ])
    const concurrent = (await db.query('SELECT scope,calls,tokens FROM spec_board_model_budget ORDER BY scope')).rows
    assert.deepEqual(concurrent.map(row => [row.scope, row.calls, Number(row.tokens)]), [
      ['*', 10, 500], ['another/specs', 5, 500], ['concurrent/specs', 5, 0]
    ], 'concurrent refunds and reservations preserve the other outstanding tokens')

    await db.query('TRUNCATE spec_board_model_budget, spec_board_model_cooldown')
    const partial = await reserveModelBudget(db, ['first/specs', 'second/specs'], 100, { config })
    await db.query("DELETE FROM spec_board_model_budget WHERE scope='second/specs'")
    await assert.rejects(partial.releaseTokens(), /reservation/)
    assert.deepEqual((await db.query('SELECT scope,calls,tokens FROM spec_board_model_budget ORDER BY scope')).rows
      .map(row => [row.scope, row.calls, Number(row.tokens)]), [['*', 1, 100], ['first/specs', 1, 100]],
    'a missing project row rolls back every part of the refund')
    await db.query("INSERT INTO spec_board_model_budget(scope,calls,tokens) VALUES('second/specs',1,100)")
    await assert.rejects(partial.releaseTokens(), /reservation/,
      'a failed refund capability is not retried after the database changes')
    assert.deepEqual((await db.query('SELECT tokens FROM spec_board_model_budget ORDER BY scope')).rows
      .map(row => Number(row.tokens)), [100, 100, 100])

    await db.query('TRUNCATE spec_board_model_budget, spec_board_model_cooldown')
    let loseCommitReply = false
    const uncertainDb = { connect: async () => {
      const client = await db.connect()
      return { release: () => client.release(), query: async (...args) => {
        const result = await client.query(...args)
        if (args[0] === 'COMMIT' && loseCommitReply) {
          loseCommitReply = false
          throw new Error('Commit reply lost')
        }
        return result
      } }
    } }
    const uncertain = await reserveModelBudget(uncertainDb, ['uncertain/specs'], 100, { config })
    await reserveModelBudget(db, ['uncertain/specs'], 100, { config })
    loseCommitReply = true
    await assert.rejects(uncertain.releaseTokens(), /Commit reply lost/)
    await assert.rejects(uncertain.releaseTokens(), /Commit reply lost/)
    assert.deepEqual((await db.query('SELECT calls,tokens FROM spec_board_model_budget ORDER BY scope')).rows
      .map(row => [row.calls, Number(row.tokens)]), [[2, 100], [2, 100]],
    'an ambiguous commit reply must not refund another request on retry')

    await db.query('TRUNCATE spec_board_model_budget, spec_board_model_cooldown')
    const dayDb = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 1 })
    try {
      await dayDb.query("SET TIME ZONE 'Etc/GMT-14'")
      const { rows: [{ day: originalDay }] } = await dayDb.query('SELECT CURRENT_DATE::text AS day')
      const previousDay = await reserveModelBudget(dayDb, ['midnight/specs'], 100, { config })
      await dayDb.query("SET TIME ZONE 'Etc/GMT+12'")
      const { rows: [{ day: currentDay }] } = await dayDb.query('SELECT CURRENT_DATE::text AS day')
      assert.notEqual(originalDay, currentDay)
      await dayDb.query(`INSERT INTO spec_board_model_budget(scope,day,calls,tokens)
        VALUES('*',CURRENT_DATE,1,1000),('midnight/specs',CURRENT_DATE,1,1000)
        ON CONFLICT(scope,day) DO UPDATE SET calls=1,tokens=1000`)
      await previousDay.releaseTokens()
      const { rows: current } = await dayDb.query(`SELECT scope,tokens FROM spec_board_model_budget
        WHERE day=CURRENT_DATE AND scope IN ('*','midnight/specs') ORDER BY scope`)
      assert.deepEqual(current.map(row => Number(row.tokens)), [1000, 1000],
        'a date change does not refund the new day')
      const { rows: original } = await dayDb.query(`SELECT scope,tokens FROM spec_board_model_budget
        WHERE day=$1::date AND scope IN ('*','midnight/specs') ORDER BY scope`, [originalDay])
      assert.deepEqual(original.map(row => Number(row.tokens)), [0, 0],
        'refunds use the database date captured by their reservation')
    } finally { await dayDb.end() }

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
