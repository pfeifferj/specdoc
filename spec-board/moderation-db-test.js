const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { migrateModeration, assertModerationAllowed, assertAutomationContext, reportContent, moderate, createModerationService } = require('./moderation')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) throw new Error('AUDIT_TEST_DATABASE_URL must identify a disposable test database')

async function main () {
  const schema = 'moderation_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  const reporter = { provider: 'github', subject: '123', login: 'reporter' }
  const moderator = { provider: 'github', subject: '456', login: 'moderator' }
  const spec = { id: 'public-note', ownerSubject: '789', title: 'Public note' }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 })
    await migrateModeration(db)
    await migrateModeration(db)
    await db.query('CREATE TABLE "Users" (id text PRIMARY KEY, profileid text, profile text)')
    await db.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY, permission text, "ownerId" text REFERENCES "Users"(id))')
    await db.query('INSERT INTO "Users" VALUES ($1,$2,$3)', ['owner', 'github:789', JSON.stringify({ provider: 'github', id: 789 })])
    await db.query('INSERT INTO "Notes" VALUES ($1,$2,$3)', [spec.id, 'editable', 'owner'])
    await assertAutomationContext(db, [spec.id, spec.id])
    await assert.rejects(assertAutomationContext(db, [spec.id, 'deleted']), /Review context/)
    await db.query('UPDATE "Notes" SET permission=$1', ['private'])
    await assert.rejects(assertAutomationContext(db, [spec.id]), /Review context/)
    await db.query('UPDATE "Notes" SET permission=$1', ['editable'])
    await assert.rejects(reportContent(db, { login: 'reporter' }, spec, 'spam', 'Repeated irrelevant promotion'), /Sign in/)
    const reports = await Promise.all(Array.from({ length: 12 }, () => reportContent(db, reporter, spec, 'spam', 'Repeated irrelevant promotion')))
    assert.equal(new Set(reports).size, 1, 'repeat reports coalesce even under concurrency')
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM spec_board_moderation_notes')).rows[0].n, 0, 'report count does not hide content')
    await assertModerationAllowed(db, spec)
    for (let i = 0; i < 4; i++) await reportContent(db, reporter, { ...spec, id: `note-${i}` }, 'spam', 'Other spam content')
    await assert.rejects(reportContent(db, reporter, { ...spec, id: 'note-six' }, 'spam', 'Other spam content'), /Daily report limit/)
    await moderate(db, moderator, 'hide', spec.id, 'Confirmed repeated advertising')
    await assert.rejects(assertModerationAllowed(db, spec), /restricted/)
    await assert.rejects(assertAutomationContext(db, [spec.id]), /restricted/)
    await moderate(db, moderator, 'restore', spec.id, 'Appeal accepted after review')
    await assertModerationAllowed(db, spec)
    await moderate(db, moderator, 'suspend', '789', 'Repeated spam after warning')
    await assert.rejects(assertModerationAllowed(db, spec), /restricted/)
    await assert.rejects(assertAutomationContext(db, [spec.id]), /restricted/)
    await moderate(db, moderator, 'unsuspend', '789', 'Account owner remediation verified')
    await assertModerationAllowed(db, spec)
    await assertAutomationContext(db, [spec.id])
    await assert.rejects(moderate(db, moderator, 'suspend', '456', 'Cannot suspend self'), /own account/)
    await moderate(db, moderator, 'close-report', reports[0], 'Reviewed and resolved')
    const events = (await db.query('SELECT action,reason FROM spec_board_moderation_events ORDER BY id')).rows
    assert.deepEqual(events.map(e => e.action), ['hide', 'restore', 'suspend', 'unsuspend', 'close-report'])
    assert.ok(events.every(e => e.reason.length >= 5))

    const claim = await db.connect()
    await claim.query('BEGIN')
    await assertModerationAllowed(claim, spec)
    let completed = false
    const hide = moderate(db, moderator, 'hide', spec.id, 'New confirmed abuse').then(() => { completed = true })
    await claim.query('SELECT 1')
    assert.equal(completed, false, 'moderator decision serializes with a pending publication claim')
    await claim.query('COMMIT'); claim.release(); await hide
    await assert.rejects(assertModerationAllowed(db, spec), /restricted/)

    let who = reporter
    const service = createModerationService({ pool: db, session: () => who,
      csrfToken: who => { assert.equal(who.provider, 'github'); assert.ok(who.subject); return 'csrf' }, isAdmin: s => s?.subject === moderator.subject,
      readBody: async () => 'csrf=wrong&action=restore&target=public-note&reason=Bypass+attempt',
      startLogin: (req, res) => res.writeHead(401).end(), basicPage: (title, body) => body,
      visibleSpecs: async () => [] })
    const response = () => ({ writeHead (status) { this.status = status; return this }, end (body) { this.body = body; return this } })
    let res = response()
    await service.handle({ method: 'POST' }, res, new URL('https://board.test/moderation'))
    assert.equal(res.status, 403, 'normal reporters cannot moderate')
    who = moderator; res = response()
    await service.handle({ method: 'POST' }, res, new URL('https://board.test/moderation'))
    assert.equal(res.status, 403, 'moderator changes require CSRF')
    res = response()
    await service.handle({ method: 'GET' }, res, new URL('https://board.test/moderation/report?note=hidden'))
    assert.equal(res.status, 404, 'report route does not disclose hidden notes')
    for (const target of ['../file.png', '/uploads/file.png', 'https://editor.test/uploads/file.png', '%66ile.png']) {
      await assert.rejects(moderate(db, moderator, 'block-upload', target, 'Confirmed hosting abuse'), /Invalid moderation target/)
    }
    await moderate(db, moderator, 'block-upload', 'file.png', 'Confirmed hosting abuse')
    assert.equal((await db.query("SELECT state FROM spec_board_moderation_uploads WHERE filename='file.png'")).rows[0].state, 'hidden')
    await moderate(db, moderator, 'restore-upload', 'file.png', 'Appeal accepted after review')
    assert.equal((await db.query("SELECT state FROM spec_board_moderation_uploads WHERE filename='file.png'")).rows[0].state, 'visible')
    assert.deepEqual((await db.query("SELECT action,previous FROM spec_board_moderation_events WHERE target='file.png' ORDER BY id")).rows.map(row => [row.action, row.previous?.state || null]),
      [['block-upload', null], ['restore-upload', 'hidden']])
    console.log('moderation: reporter limits, no report brigading, reversible actions, audit, serialization and authorization passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
