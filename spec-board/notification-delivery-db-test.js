const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { migrateNotifications } = require('./notification-store')
const { createNotificationDelivery } = require('./notification-delivery')
const { createHealthState } = require('./health-state')
const connectionString = process.env.NOTIFICATIONS_TEST_DATABASE_URL
if (!connectionString) { console.error('Set NOTIFICATIONS_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
const key = email => crypto.createHash('sha256').update(email).digest('hex')
async function main () {
  const schema = 'delivery_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
    await db.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY, permission text)')
    await db.query('CREATE TABLE spec_board_state (note_id text PRIMARY KEY)')
    await db.query('CREATE TABLE spec_board_optout (email_hash text PRIMARY KEY)')
    await db.query(`CREATE TABLE spec_board_notifications (id serial PRIMARY KEY, email text NOT NULL,
      note_id text NOT NULL, title text, line text NOT NULL, created_at timestamptz DEFAULT now(), attempts integer NOT NULL DEFAULT 0)`)
    await migrateNotifications(db)
    await db.query("INSERT INTO \"Notes\" VALUES ('public','editable'),('hidden','private')")
    const enqueue = (email, count = 1, note = 'public') => db.query(`INSERT INTO spec_board_notifications (email,note_id,line,created_at)
      SELECT $1,$2,'row-' || n,now() - interval '5 hours' FROM generate_series(1,$3::integer) n`, [email, note, count])
    const sent = []
    const base = { db, emailKey: key, from: 'from@test', debounceMinutes: 0, maxRecipients: 1, rowLimit: 2,
      unsubUrl: () => 'https://board.test/unsubscribe', emailFooter: () => 'Footer',
      renderDigest: (rows, footer) => ({ subject: 'Activity', text: rows.map(r => r.line).join(',') + footer }),
      mailer: { sendMail: async mail => { sent.push(mail) } } }
    await enqueue('a@test', 5); await enqueue('b@test'); await enqueue('c@test')
    const delivery = createNotificationDelivery(base)
    await delivery.flush(); await delivery.flush(); await delivery.flush()
    assert.deepEqual(sent.map(m => m.to), ['a@test', 'b@test', 'c@test'], 'a capped backlog does not monopolize recipients')
    assert.equal(delivery.status().queued, 3)
    assert.equal(delivery.status().recipients, 1)
    assert.ok(delivery.status().oldestAgeSeconds >= 5 * 3600)
    assert.ok(!JSON.stringify(delivery.status()).includes('@test'))
    assert.equal(sent[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
    await db.query("INSERT INTO spec_board_notifications (email,note_id,line) VALUES ('new@test','public','fresh')")
    await delivery.flush()
    assert.equal(sent[3].to, 'a@test', 'new recipients cannot repeatedly overtake an older deferred recipient')
    await delivery.flush()
    assert.equal(sent[4].to, 'new@test', 'after one batch the older backlog yields to the fresh recipient')
    await db.query('DELETE FROM spec_board_notifications')
    sent.length = 0
    await enqueue('arriving@test', 2)
    const arriving = createNotificationDelivery({ ...base, mailer: { sendMail: async () => {
      await enqueue('arriving@test')
    } } })
    const one = arriving.flush()
    assert.equal(arriving.flush(), one, 'overlapping flushes share the same running batch')
    await one
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 1,
      'a row arriving during SMTP survives captured-ID deletion')
    await db.query('DELETE FROM spec_board_notifications')
    await enqueue('muted@test'); await enqueue('hidden@test', 1, 'hidden'); await enqueue('deleted@test', 1, 'gone')
    await db.query('INSERT INTO spec_board_optout VALUES ($1)', [key('muted@test')])
    await createNotificationDelivery({ ...base, maxRecipients: 8 }).flush()
    assert.equal(sent.length, 0, 'current opt-out, private and deleted notes are never delivered')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 0)
    await enqueue('failing@test', 5)
    let attempts = 0
    const health = createHealthState()
    const failing = createNotificationDelivery({ ...base, health, debounceMinutes: 30,
      mailer: { sendMail: async () => { attempts++; throw Object.assign(new Error('secret recipient'), { code: 'EAUTH' }) } } })
    await failing.flush(); await failing.flush()
    assert.equal(attempts, 1)
    assert.equal(failing.status().ok, false, 'an idle backoff pass cannot clear an SMTP failure')
    assert.equal(failing.status().error, 'EAUTH')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications WHERE last_attempt_at IS NOT NULL')).rows[0].n, 5)
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications WHERE attempts=1')).rows[0].n, 2)
    const restarted = createNotificationDelivery({ ...base, debounceMinutes: 30 })
    await restarted.flush()
    assert.equal(restarted.status().ok, false, 'persisted failed rows remain degraded after restarting during backoff')
    assert.equal(restarted.status().error, 'DeliveryPendingRetry')
    await db.query('DELETE FROM spec_board_notifications')
    await enqueue('a@test'); await enqueue('b@test')
    let time = 0
    sent.length = 0
    const bounded = createNotificationDelivery({ ...base, maxRecipients: 8, budgetMs: 5, now: () => time,
      mailer: { sendMail: async mail => { sent.push(mail); time += 6 } } })
    await bounded.flush()
    assert.equal(sent.length, 1, 'a slow SMTP attempt prevents another recipient from starting past the budget')
    const stopped = createNotificationDelivery({ ...base, shouldStop: () => true })
    await stopped.flush()
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 1)
    await db.query('UPDATE spec_board_notifications SET attempts=20')
    await bounded.flush()
    assert.equal(bounded.status().error, 'DeliveryExhausted')
    assert.equal(bounded.status().dropped, 1)
    assert.equal(bounded.status().queued, 0)
    console.log('notification delivery database tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
