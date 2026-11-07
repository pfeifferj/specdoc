const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { migrateNotifications, insertNotifications } = require('./notification-store')
const { createNotificationDelivery } = require('./notification-delivery')
const { createHealthState } = require('./health-state')
const { migrateModeration } = require('./moderation')
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
    await db.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY, permission text, "ownerId" text)')
    await db.query('CREATE TABLE "Users" (id text PRIMARY KEY, profileid text, profile text)')
    await db.query('CREATE TABLE spec_board_state (note_id text PRIMARY KEY)')
    await db.query('CREATE TABLE spec_board_optout (email_hash text PRIMARY KEY)')
    await db.query(`CREATE TABLE spec_board_notifications (id serial PRIMARY KEY, email text NOT NULL,
      note_id text NOT NULL, title text, line text NOT NULL, created_at timestamptz DEFAULT now(), attempts integer NOT NULL DEFAULT 0)`)
    await migrateNotifications(db)
    await migrateModeration(db)
    await db.query("INSERT INTO \"Notes\"(shortid,permission) VALUES ('public','editable'),('hidden','private'),('other','editable')")
    const verify = email => db.query('INSERT INTO "Users" VALUES($1,\'github:42\',$2) ON CONFLICT(id) DO NOTHING',
      [email, JSON.stringify({ provider: 'github', id: '42', emails: [{ value: email, verified: true, primary: true }] })])
    const enqueue = async (email, count = 1, note = 'public') => {
      await verify(email)
      return db.query(`INSERT INTO spec_board_notifications (email,note_id,line,created_at,address_verified)
        SELECT $1,$2,'row-' || n,now() - interval '5 hours',true FROM generate_series(1,$3::integer) n`, [email, note, count])
    }
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
    await db.query("INSERT INTO spec_board_notifications (email,note_id,line,address_verified) VALUES ('new@test','public','fresh',true)")
    await verify('new@test')
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
    await enqueue('revoked@test')
    await db.query('UPDATE "Users" SET profile=$1 WHERE id=$2', [JSON.stringify({ provider: 'github', id: '42', emails: [] }), 'revoked@test'])
    await db.query("INSERT INTO spec_board_notifications(email,note_id,line,created_at) VALUES('unverified@test','public','legacy unverified',now()-interval '5 hours')")
    await db.query("INSERT INTO spec_board_notifications(email,note_id,line,created_at) VALUES('a@test','public','legacy unauthenticated subscription',now()-interval '5 hours')")
    await createNotificationDelivery({ ...base, maxRecipients: 8 }).flush()
    assert.equal(sent.length, 0, 'revoked addresses and legacy unverified recipients are checked again before SMTP')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 0)
    await enqueue('suspended@test')
    await enqueue('suspended@test', 1, 'other')
    await db.query("UPDATE spec_board_notifications SET line=CASE note_id WHEN 'public' THEN 'suspended content' ELSE 'allowed content' END WHERE email='suspended@test'")
    await db.query('UPDATE "Notes" SET "ownerId"=$1 WHERE shortid=$2', ['suspended@test', 'public'])
    await db.query("INSERT INTO spec_board_moderation_accounts(provider,subject,state,actor,reason) VALUES('github','42','suspended','99','Confirmed abuse')")
    await createNotificationDelivery({ ...base, maxRecipients: 8 }).flush()
    assert.deepEqual(sent.map(mail => mail.text), ['allowed contentFooter'], 'suspended owner content is withheld without holding back the rest of the digest')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 0)
    await db.query('DELETE FROM spec_board_moderation_accounts')
    await db.query('UPDATE "Notes" SET "ownerId"=NULL')
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
    sent.length = 0
    await verify('mixed@test')
    await verify('backlog@test')
    await db.query(`INSERT INTO spec_board_notifications (email,note_id,line,event,created_at,address_verified) VALUES
      ('mixed@test','public','discussion',NULL,now()-interval '5 hours',true),
      ('mixed@test','public','reminder','{"version":1,"kind":"review-attention"}',now()-interval '5 hours',true)`)
    let policyUnavailable = false
    const deferred = createNotificationDelivery({ ...base, filterNotifications: async (db, rows) => ({
      visible: rows.filter(row => row.line === 'discussion'), deferred: rows.filter(row => row.line === 'reminder'),
      unavailable: policyUnavailable ? rows.filter(row => row.line === 'reminder') : []
    }) })
    await deferred.flush()
    assert.equal(sent.length, 1)
    assert.ok(sent[0].text.includes('discussion'))
    assert.ok(!sent[0].text.includes('reminder'))
    assert.equal(deferred.status().ok, true, 'an unresolved discussion is normal review activity, not a mail outage')
    assert.equal(deferred.status().failing, 0)
    assert.equal(deferred.status().deferred, 1)
    const blockedRestart = createNotificationDelivery(base)
    await blockedRestart.flush()
    assert.notEqual(blockedRestart.status().ok, false, 'persisted blocked reminders do not report an outage after restart')
    policyUnavailable = true
    await db.query("UPDATE spec_board_notifications SET next_attempt_at=now()-interval '1 minute'")
    await deferred.flush()
    assert.equal(deferred.status().ok, false, 'unavailable reviewer policy still reports a failure')
    assert.equal(deferred.status().error, 'ReviewReminderPolicyUnavailable')
    assert.equal(deferred.status().failing, 1)
    await enqueue('healthy@test')
    await db.query("UPDATE spec_board_notifications SET line='discussion' WHERE email='healthy@test'")
    await deferred.flush()
    assert.equal(sent.length, 2, 'unrelated discussion mail can still be delivered')
    assert.equal(deferred.status().ok, false, 'successful unrelated mail does not hide an outstanding policy outage')
    assert.equal(deferred.status().deferred, 1)
    const policyRestart = createNotificationDelivery(base)
    await policyRestart.flush()
    assert.equal(policyRestart.status().ok, false, 'policy failures survive a restart during backoff')
    policyUnavailable = false
    await db.query("UPDATE spec_board_notifications SET next_attempt_at=now()-interval '1 minute'")
    await deferred.flush()
    assert.equal(deferred.status().ok, true, 'policy recovery clears the outage even if a discussion still blocks the reminder')
    assert.equal(deferred.status().failing, 0)
    assert.equal(deferred.status().deferred, 1)
    const waiting = (await db.query('SELECT line,attempts FROM spec_board_notifications')).rows
    assert.deepEqual(waiting, [{ line: 'reminder', attempts: 0 }], 'a policy outage cannot consume the SMTP retry budget')
    await db.query("UPDATE spec_board_notifications SET next_attempt_at=now()-interval '1 minute'")
    await createNotificationDelivery(base).flush()
    assert.equal(sent.length, 3, 'a deferred reminder remains deliverable after its policy recovers')
    await db.query('DELETE FROM spec_board_notifications')
    sent.length = 0
    await db.query(`INSERT INTO spec_board_notifications (email,note_id,line,created_at,address_verified) VALUES
      ('backlog@test','public','reminder',now()-interval '6 hours',true),
      ('backlog@test','public','reminder',now()-interval '5 hours',true),
      ('backlog@test','public','discussion',now()-interval '4 hours',true)`)
    await deferred.flush()
    assert.equal(sent.length, 0)
    await deferred.flush()
    assert.equal(sent.length, 1, 'a full deferred batch cannot starve a later deliverable event')
    assert.ok(sent[0].text.includes('discussion'))
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 2)
    await db.query("UPDATE spec_board_notifications SET created_at=now()-interval '8 days'")
    await deferred.flush()
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_notifications')).rows[0].n, 0,
      'permanently unavailable policies cannot retain notifications forever')
    sent.length = 0
    await enqueue('expired@test', 5)
    await db.query("UPDATE spec_board_notifications SET created_at=now()-interval '8 days'")
    await enqueue('current@test')
    await createNotificationDelivery(base).flush()
    assert.deepEqual(sent.map(mail => mail.to), ['current@test'],
      'expired rows beyond the cleanup batch cannot be delivered')
    await db.query('DELETE FROM spec_board_notifications')
    for (const [email, minutes, oldAge] of [['daily@test', 1440, '8 days 1 hour'], ['weekly@test', 10080, '57 days']]) {
      sent.length = 0
      await verify(email)
      await db.query(`INSERT INTO spec_board_notifications (email,note_id,line,created_at,address_verified)
        VALUES ($1,'public','oldest event',now()-$2::interval,true)`, [email, oldAge])
      await insertNotifications(db, { id: 'public', namespace: 'test/specs', title: 'Public' },
        ['recent event'], [{ email, reasons: ['watching'] }])
      await createNotificationDelivery({ ...base, debounceMinutes: minutes }).flush()
      assert.equal(sent.length, 1, 'the digest reaches its eight-interval fallback despite new activity')
      assert.ok(sent[0].text.includes('oldest event'))
      assert.ok(sent[0].text.includes('recent event'))
      await db.query('DELETE FROM spec_board_notifications')
    }
    console.log('notification delivery database tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
