const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { migrateNotifications, visibleNotifications, dueRecipients } = require('./notification-store')
const { discussionState, discussionEvents, event, renderDigest } = require('./notifications')
const connectionString = process.env.NOTIFICATIONS_TEST_DATABASE_URL
if (!connectionString) { console.error('Set NOTIFICATIONS_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
process.env.SMTP_HOST = 'mail.invalid'
process.env.SPEC_BOARD_BASE_URL = 'https://board.test'
process.env.SESSION_SECRET = 'notification-tests-only'
const { withTx, upsertState, enqueueEmails } = require('./server')

async function main () {
  const schema = 'notifications_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  const spec = { id: 'a', title: 'Public spec', namespace: 'team/specs', url: 'https://notes.test/a' }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
    await db.query('CREATE TABLE "Users" (id text PRIMARY KEY, email text, profile text)')
    await db.query('CREATE TABLE "Notes" (id text PRIMARY KEY, shortid text UNIQUE, "ownerId" text, permission text)')
    await db.query('CREATE TABLE "Authors" ("noteId" text, "userId" text)')
    await db.query('CREATE TABLE spec_board_subscriptions (user_id text, namespace text, level text)')
    await db.query('CREATE TABLE spec_board_notify_email (user_id text, namespace text, email text)')
    await db.query('CREATE TABLE spec_board_optout (email_hash text PRIMARY KEY)')
    await db.query('CREATE TABLE spec_board_state (note_id text PRIMARY KEY, status text)')
    await db.query(`CREATE TABLE spec_board_notifications (id serial PRIMARY KEY, email text NOT NULL,
      note_id text NOT NULL, title text, line text NOT NULL, created_at timestamptz DEFAULT now())`)
    await db.query(`INSERT INTO spec_board_notifications (email,note_id,title,line)
      VALUES ('legacy@test','a','Legacy title','Existing queue row')`)
    await migrateNotifications(db)
    await migrateNotifications(db)
    assert.equal((await db.query('SELECT event FROM spec_board_notifications')).rows[0].event, null)
    await db.query('DELETE FROM spec_board_notifications')
    await db.query(`INSERT INTO spec_board_notifications (email,note_id,line,created_at,last_attempt_at)
      VALUES ('retry@test','a','old',now() - interval '5 hours',now() - interval '31 minutes'),
             ('retry@test','a','fresh',now(),NULL)`)
    assert.deepEqual(await dueRecipients(db, 30), [{ email: 'retry@test' }])
    await db.query('UPDATE spec_board_notifications SET last_attempt_at=now() WHERE line=$1', ['old'])
    assert.deepEqual(await dueRecipients(db, 30), [])
    await db.query('DELETE FROM spec_board_notifications')
    await db.query(`INSERT INTO "Users" VALUES ('owner','owner@test',NULL), ('watch','watch@test',NULL), ('muted','muted@test',NULL)`)
    await db.query(`INSERT INTO "Notes" VALUES ('note','a','owner','editable')`)
    await db.query(`INSERT INTO spec_board_subscriptions VALUES ('watch','team/specs','watch'), ('muted','team/specs','watch'), ('muted','team/specs','disabled')`)
    await db.query(`INSERT INTO "Authors" VALUES ('note','muted')`)
    const before = discussionState('', spec.url).baseline
    const current = discussionState('{>>@Alice: Please clarify validation.<<}', spec.url)
    await upsertState({ id: 'a', status: 'ready-for-review', discussionHashes: before }, db)
    const events = [event('status', 'Review started', { from: 'ready-for-review', to: 'in-review', url: spec.url }),
      ...discussionEvents(before, current, spec)]
    await db.query("ALTER TABLE spec_board_notifications ADD CONSTRAINT reject_watch CHECK (email <> 'watch@test')")
    await assert.rejects(withTx(async client => {
      await upsertState({ id: 'a', status: 'in-review', discussionHashes: current.baseline }, client)
      await enqueueEmails(spec, events, null, client)
    }, db), /reject_watch/)
    let stored = (await db.query('SELECT * FROM spec_board_state')).rows[0]
    assert.equal(stored.status, 'ready-for-review')
    assert.deepEqual(stored.discussion_hashes, before)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM spec_board_notifications')).rows[0].n, 0)
    await db.query('ALTER TABLE spec_board_notifications DROP CONSTRAINT reject_watch')
    await withTx(async client => {
      await upsertState({ id: 'a', status: 'in-review', discussionHashes: current.baseline }, client)
      await enqueueEmails(spec, events, null, client)
    }, db)
    stored = (await db.query('SELECT * FROM spec_board_state')).rows[0]
    assert.equal(stored.status, 'in-review')
    assert.deepEqual(stored.discussion_hashes, current.baseline)
    let rows = (await db.query('SELECT * FROM spec_board_notifications ORDER BY id')).rows
    assert.equal(rows.length, 4)
    assert.deepEqual([...new Set(rows.map(r => r.email))].sort(), ['owner@test', 'watch@test'])
    assert.deepEqual(rows.find(r => r.email === 'owner@test').event.reasons, ['participating'])
    assert.deepEqual(rows.find(r => r.email === 'watch@test').event.reasons, ['watching'])
    await withTx(async client => {
      await enqueueEmails(spec, discussionEvents(stored.discussion_hashes, current, spec), null, client)
      await upsertState({ id: 'a', discussionHashes: current.baseline }, client)
    }, db)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM spec_board_notifications')).rows[0].n, 4)
    await db.query('DELETE FROM spec_board_notifications')
    await enqueueEmails(spec, [event('approval-stale', 'Changed since approval', { url: spec.url })], 'owner', db)
    rows = (await db.query('SELECT * FROM spec_board_notifications')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].email, 'owner@test')
    assert.deepEqual(rows[0].event.reasons, ['approval-stale'])
    assert.equal((await visibleNotifications(db, rows)).length, 1)
    for (const permission of ['private', 'limited', 'protected']) {
      await db.query('UPDATE "Notes" SET permission=$1', [permission])
      const visible = await visibleNotifications(db, rows)
      assert.deepEqual(visible, [])
      assert.ok(!renderDigest(visible).text.includes('Public spec'))
      await enqueueEmails(spec, events, null, db)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM spec_board_notifications')).rows[0].n, 1)
    }
    await db.query("UPDATE \"Notes\" SET permission='editable'")
    await db.query('INSERT INTO spec_board_optout VALUES ($1)', [crypto.createHash('sha256').update('owner@test').digest('hex')])
    await enqueueEmails(spec, events, 'owner', db)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM spec_board_notifications')).rows[0].n, 1)
    await db.query('DELETE FROM "Notes"')
    assert.deepEqual(await visibleNotifications(db, rows), [])
    await db.query('ALTER TABLE "Notes" RENAME TO temporarily_unavailable')
    await assert.rejects(visibleNotifications(db, rows), /does not exist/)
    console.log('notification database tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
