'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Pool } = require('pg')
const { installEditorFunctions, assertMigrationTarget, recordSchema, grantRuntime, verifyRuntime } = require('./database-admin')
const { publicationGuard } = require('./schema-guard')
const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const suffix = crypto.randomBytes(8).toString('hex')
  const board = `board_priv_${suffix}`, editor = `editor_priv_${suffix}`
  const migrator = `migrate_priv_${suffix}`, runtime = `runtime_priv_${suffix}`, editorRole = `editor_role_${suffix}`
  const admin = new Pool({ connectionString, max: 1 })
  let migration, service, editorDb
  try {
    for (const role of [migrator, runtime, editorRole]) await admin.query(`CREATE ROLE ${role}`)
    await admin.query(`CREATE SCHEMA ${board} AUTHORIZATION ${migrator}`)
    await admin.query(`CREATE SCHEMA ${editor} AUTHORIZATION ${editorRole}`)
    await admin.query(`GRANT USAGE ON SCHEMA ${editor} TO ${migrator} WITH GRANT OPTION`)
    await admin.query(`CREATE TABLE ${editor}."Notes" (id uuid PRIMARY KEY, shortid text UNIQUE, content text, permission text,
      alias text, title text, authorship text, "lastchangeAt" timestamptz DEFAULT now(), "ownerId" text, "lastchangeuserId" text)`)
    await admin.query(`CREATE TABLE ${editor}."Users" (id text PRIMARY KEY, profile text, profileid text, email text, "accessToken" text)`)
    await admin.query(`CREATE TABLE ${editor}."Authors" ("noteId" uuid, "userId" text)`)
    await admin.query(`GRANT SELECT,UPDATE,REFERENCES ON ALL TABLES IN SCHEMA ${editor} TO ${migrator} WITH GRANT OPTION`)
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${editor} TO ${editorRole}`)
    await admin.query(`INSERT INTO ${editor}."Users" VALUES ('user',$1,'github:42','owner@example.test','private-oauth-token')`,
      [JSON.stringify({ provider: 'github', id: '42', username: 'owner', emails: [] })])
    await admin.query(`INSERT INTO ${editor}."Notes" (id,shortid,content,permission,title,"ownerId","lastchangeuserId")
      VALUES ($1,'note','original','editable','Review','user','user')`, [crypto.randomUUID()])
    migration = new Pool({ connectionString, options: `-c role=${migrator} -c search_path=${board},${editor}`, max: 2 })
    await assertMigrationTarget(migration)
    process.env.NAMESPACES = 'team/specs'
    process.env.DEFAULT_NAMESPACE = 'team/specs'
    const file = path.join(__dirname, 'server.js')
    const fixture = new Module(file + '.privileges-test', module)
    fixture.filename = file
    fixture.paths = Module._nodeModulePaths(__dirname)
    const realRequire = fixture.require.bind(fixture)
    fixture.require = id => id === 'pg' ? { Pool: class { constructor () { return migration } } } : realRequire(id)
    fixture._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.ensureState=ensureState;', file)
    await fixture.exports.ensureState()
    await fixture.exports.ensureState()
    await installEditorFunctions(migration)
    await recordSchema(migration)
    await grantRuntime(migration, runtime, { editorRole })
    assert.equal((await publicationGuard(migration)).ready, true)
    service = new Pool({ connectionString, options: `-c role=${runtime} -c search_path=${board},${editor}`, max: 2 })
    editorDb = new Pool({ connectionString, options: `-c role=${editorRole} -c search_path=${editor},${board}`, max: 1 })
    await verifyRuntime(service)
    assert.equal((await publicationGuard(service, { migrate: false })).ready, true)
    await service.query('SELECT id,profile,profileid,email FROM "Users"')
    await service.query('SELECT * FROM "Notes"')
    await assert.rejects(service.query('SELECT "accessToken" FROM "Users"'), { code: '42501' })
    await assert.rejects(service.query('UPDATE "Notes" SET content=$1', ['tampered']), { code: '42501' })
    await assert.rejects(service.query('UPDATE "Users" SET profile=$1', ['{}']), { code: '42501' })
    await assert.rejects(service.query('CREATE TABLE arbitrary(id int)'), { code: '42501' })
    await assert.rejects(service.query('ALTER TABLE spec_board_state ADD COLUMN arbitrary int'), { code: '42501' })
    await assert.rejects(service.query('DELETE FROM spec_board_publication_intents'), { code: '42501' })
    await assert.rejects(service.query("UPDATE spec_board_snapshot_bodies SET body='tampered'"), { code: '42501' })
    await service.query("INSERT INTO spec_board_snapshot_bodies(hash,body) VALUES ('pin','original') ON CONFLICT(hash) DO UPDATE SET hash=EXCLUDED.hash")
    await service.query("INSERT INTO spec_board_snapshot_bodies(hash,body) VALUES ('pin','replacement') ON CONFLICT(hash) DO UPDATE SET hash=EXCLUDED.hash")
    assert.equal((await service.query("SELECT body FROM spec_board_snapshot_bodies WHERE hash='pin'")).rows[0].body, 'original')
    await service.query("INSERT INTO spec_board_governance_events(note_id,actor,action,evidence) VALUES ('note','github:42','observed','{}')")
    for (const sql of ['DELETE FROM spec_board_governance_events', "UPDATE spec_board_governance_events SET action='forged'", 'TRUNCATE spec_board_governance_events']) {
      await assert.rejects(service.query(sql), { code: '42501' })
    }
    assert.equal((await service.query('SELECT shortid FROM specdoc_lock_note($1,true)', ['note'])).rows[0].shortid, 'note')
    assert.equal((await service.query('SELECT id FROM specdoc_lock_user($1)', ['user'])).rows[0].id, 'user')
    const emails = JSON.stringify([{ value: 'verified@example.test', primary: true, verified: true }])
    assert.equal((await service.query('SELECT specdoc_set_verified_emails($1,$2,$3) AS changed', ['user', '43', emails])).rows[0].changed, 0)
    assert.equal((await service.query('SELECT specdoc_set_verified_emails($1,$2,$3) AS changed', ['user', '42', emails])).rows[0].changed, 1)
    const { rows: [saved] } = await service.query('SELECT profile FROM "Users" WHERE id=$1', ['user'])
    assert.deepEqual(JSON.parse(saved.profile), { provider: 'github', id: '42', username: 'owner', emails: JSON.parse(emails) })
    await assert.rejects(service.query('SELECT specdoc_set_verified_emails($1,$2,$3)', ['user', '42', JSON.stringify([{ value: 'x@y', primary: true, verified: false }])]), /Invalid verified email entry/)
    await migration.query('UPDATE "Notes" SET content=$1 WHERE shortid=$2', ['---\ntags: [spec, in-review]\nnamespace: team/specs\n---\n\nA reviewed requirement.', 'note'])
    const { createReviewStore } = require('./review-store')
    const { createReviewService } = require('./review-service')
    const reviewStore = createReviewStore(service)
    const discussions = createReviewService({ store: reviewStore,
      loadSource: (id, client = service, options) => fixture.exports.reviewCurrentSource(id, client, options),
      authorize: fixture.exports.authorizeReview })
    const reviewer = { provider: 'github', subject: '42', login: 'owner' }
    const discussion = await discussions.act('note', reviewer, 'thread', { body: 'Does this cover reconnects?', requestId: crypto.randomUUID() })
    assert.equal((await discussions.read('note')).openDiscussions, 1, 'restricted runtime can lock a note and save discussion')
    await discussions.act('note', reviewer, 'resolve', { threadId: discussion.threadId, version: discussion.version, requestId: crypto.randomUUID() })
    await reviewStore.withPublicationLock('note', async () => {
      await assert.rejects(discussions.act('note', reviewer, 'thread', { body: 'A racing blocker', requestId: crypto.randomUUID() }), { code: 'review-busy' })
    })
    assert.equal((await discussions.read('note')).openDiscussions, 0)
    await assert.rejects(service.query('SELECT * FROM "Notes" FOR UPDATE'), { code: '42501' }, 'the discussion path does not require direct editor writes')
    await editorDb.query('SELECT * FROM spec_board_moderation_notes')
    await editorDb.query('SELECT * FROM spec_board_moderation_accounts')
    await editorDb.query('SELECT * FROM spec_board_moderation_uploads')
    await assert.rejects(editorDb.query("INSERT INTO spec_board_moderation_uploads(filename,state,actor,reason) VALUES ('file.png','hidden','42','abuse')"), { code: '42501' })
    await assert.rejects(editorDb.query("INSERT INTO spec_board_moderation_notes VALUES ('note','hidden')"), { code: '42501' })
    await assert.rejects(editorDb.query('SELECT * FROM spec_board_governance_events'), { code: '42501' })
    await assert.rejects(editorDb.query('SELECT * FROM specdoc_lock_note($1,true)', ['note']), { code: '42501' })
    await assert.rejects(verifyRuntime(migration), /privileges are excessive/)
    await migration.query('UPDATE spec_board_schema SET version=999')
    await assert.rejects(verifyRuntime(service), /schema is incompatible/)
    console.log('Database runtime privilege separation, append-only audit, narrow email/lock operations, and schema compatibility passed')
  } finally {
    if (service) await service.end()
    if (editorDb) await editorDb.end()
    if (migration) await migration.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${board} CASCADE`)
    await admin.query(`DROP SCHEMA IF EXISTS ${editor} CASCADE`)
    for (const role of [runtime, migrator, editorRole]) await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
