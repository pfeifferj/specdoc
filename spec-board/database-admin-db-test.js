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

async function feedbackRetention (migration, service, editorDb) {
  const { createFeedbackStore } = require('./feedback-store')
  const fixtures = [
    ...['placed', 'commented', 'unplaced', 'dismissed', 'incorporated'].map(status =>
      ({ name: `old-${status}`, status, proposalAge: 91, decisionAge: 91,
        expires: ['dismissed', 'incorporated'].includes(status) })),
    ...['pending', 'stale', 'accepted'].map(status =>
      ({ name: `active-${status}`, status, proposalAge: 120, decisionAge: 120 })),
    { name: 'recent-proposal', status: 'dismissed', proposalAge: 89, decisionAge: 91 },
    { name: 'future-proposal', status: 'dismissed', proposalAge: -1, decisionAge: 120 },
    { name: 'undated-proposal', status: 'dismissed', proposalAge: null, decisionAge: 120 },
    { name: 'recent-decision', status: 'dismissed', proposalAge: 91, decisionAge: 89 },
    { name: 'future-decision', status: 'dismissed', proposalAge: 120, decisionAge: -1 },
    { name: 'backdated-proposal', status: 'dismissed', proposalAge: 1, decisionAge: 1 },
    ...[
      { name: 'scalar-extra', extra: 'reason' },
      { name: 'array-extra', extra: ['reason', { reason: 'nested' }] },
      { name: 'nested-reason', extra: { details: { reason: 'nested' } } }
    ].map(fixture => ({ ...fixture, status: 'dismissed', proposalAge: 91, decisionAge: 91 }))
  ]
  const { rows: [job] } = await migration.query(`INSERT INTO spec_board_feedback_jobs(namespace,repo,number)
    VALUES ('team/specs','team/code',1) RETURNING id`)
  const expired = new Set()
  for (const fixture of fixtures) {
    const { rows: [proposal] } = await migration.query(`INSERT INTO spec_board_feedback_proposals
      (job_id,target_note,target_namespace,group_id,source_hash,payload,status,decided_at)
      VALUES ($1,'note','team/specs',$2,'evidence','{}',$3,now()-$4::integer*interval '1 day') RETURNING id`,
    [job.id, fixture.name, fixture.status, fixture.proposalAge])
    const { rows: [decision] } = await migration.query(`INSERT INTO spec_board_feedback_decisions
      (proposal_id,namespace,action,actor,extra,created_at)
      VALUES ($1,'team/specs','reviewed',$2,$3,now()-$4::integer*interval '1 day') RETURNING id`,
    [proposal.id, JSON.stringify({ subject: '42', login: 'owner' }),
      JSON.stringify(fixture.extra ?? { reason: fixture.name, retained: { source: 'review', reason: 'nested' }, version: 1 }), fixture.decisionAge])
    if (fixture.expires) expired.add(decision.id)
    if (fixture.name === 'backdated-proposal') {
      await service.query("UPDATE spec_board_feedback_proposals SET decided_at=now()-interval '120 days' WHERE id=$1", [proposal.id])
    }
  }
  await migration.query(`INSERT INTO spec_board_feedback_decisions(namespace,action,actor,extra,created_at)
    VALUES ('team/specs','toggle','{}','{"reason":"unlinked decision","enabled":true}',now()-interval '120 days')`)
  for (const sql of [
    "UPDATE spec_board_feedback_decisions SET extra=extra-'reason'",
    "UPDATE spec_board_feedback_decisions SET created_at=now()-interval '120 days'",
    'DELETE FROM spec_board_feedback_decisions',
    'TRUNCATE spec_board_feedback_decisions'
  ]) await assert.rejects(service.query(sql), { code: '42501' })
  const before = (await service.query('SELECT * FROM spec_board_feedback_decisions ORDER BY id')).rows
  const expected = before.map(row => {
    if (!expired.has(row.id)) return row
    const extra = { ...row.extra }
    delete extra.reason
    return { ...row, extra }
  })
  const store = createFeedbackStore(service)
  await store.cleanup()
  assert.deepEqual((await service.query('SELECT * FROM spec_board_feedback_decisions ORDER BY id')).rows, expected,
    'cleanup removes only expired closed-proposal reasons and preserves the rest of the decision')
  await store.cleanup()
  assert.deepEqual((await service.query('SELECT * FROM spec_board_feedback_decisions ORDER BY id')).rows, expected)
  await assert.rejects(editorDb.query('SELECT specdoc_purge_feedback_reasons()'), { code: '42501' },
    'a role with schema access does not inherit PUBLIC permission to purge reasons')
  await assert.rejects(service.query("SELECT specdoc_purge_feedback_reasons(now()+interval '1 year')"), { code: '42883' },
    'the caller cannot supply a retention cutoff')
}

async function editorTempTypes (migration, service, board, runtime) {
  await migration.query(`CREATE TABLE ${board}.type_shadow_probe (operation text, actor text)`)
  await migration.query(`GRANT SELECT ON ${board}.type_shadow_probe TO ${runtime}`)
  const client = await service.connect()
  try {
    await client.query('BEGIN')
    assert.equal((await client.query('SELECT has_table_privilege(current_user,$1,\'INSERT\') AS allowed',
      [`${board}.type_shadow_probe`])).rows[0].allowed, false)
    await client.query('CREATE TEMP TABLE type_shadow_init (id integer) ON COMMIT DROP')
    await client.query(`CREATE FUNCTION pg_temp.capture_type_cast() RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO ${board}.type_shadow_probe VALUES (current_setting('specdoc.test_operation'),current_user);
        RETURN true;
      END $$`)
    await client.query('CREATE DOMAIN pg_temp.text AS pg_catalog.text CHECK (pg_temp.capture_type_cast())')
    await client.query('CREATE DOMAIN pg_temp.jsonb AS pg_catalog.jsonb CHECK (pg_temp.capture_type_cast())')
    await client.query("SELECT set_config('specdoc.test_operation','lock',true)")
    assert.equal((await client.query('SELECT shortid FROM specdoc_lock_note($1,true)', ['note'])).rows[0].shortid, 'note')
    assert.equal((await client.query('SELECT id FROM specdoc_lock_user($1)', ['user'])).rows[0].id, 'user')
    await client.query("SELECT set_config('specdoc.test_operation','verified-emails',true)")
    const emails = JSON.stringify([{ value: 'shadow@example.test', primary: true, verified: true }])
    assert.equal((await client.query('SELECT specdoc_set_verified_emails($1,$2,$3) AS changed', ['user', '42', emails])).rows[0].changed, 1)
    assert.deepEqual((await client.query(`SELECT operation,actor FROM ${board}.type_shadow_probe`)).rows, [],
      'runtime-created type checks must not execute with the editor functions\' migration privileges')
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

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
    process.env.SPECDOC_SECRET_KEY = crypto.randomBytes(32).toString('base64')
    fixture._compile(fs.readFileSync(file, 'utf8') + '\nObject.assign(module.exports,{ensureState,saveBot,loadBots,listBotsForForm});', file)
    await migration.query(`CREATE TABLE spec_board_bots (
      name text PRIMARY KEY, url text NOT NULL, api_key text, model text NOT NULL, prompt text,
      namespaces text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true)`)
    await migration.query("INSERT INTO spec_board_bots(name,url,model) VALUES ('existing-bot','https://model.example','example')")
    await fixture.exports.ensureState()
    await fixture.exports.ensureState()
    assert.deepEqual((await migration.query("SELECT response_format,reasoning_effort,endpoint_mode,temperature,token_limit_parameter FROM spec_board_bots WHERE name='existing-bot'")).rows[0],
      { response_format: 'json_schema', reasoning_effort: null, endpoint_mode: 'base', temperature: 0.2, token_limit_parameter: 'max_tokens' })
    await migration.query("UPDATE spec_board_bots SET response_format='json_object',reasoning_effort='none' WHERE name='existing-bot'")
    await assert.rejects(migration.query("UPDATE spec_board_bots SET response_format='text' WHERE name='existing-bot'"), { code: '23514' })
    await assert.rejects(migration.query("UPDATE spec_board_bots SET reasoning_effort='unbounded' WHERE name='existing-bot'"), { code: '23514' })
    for (const assignment of ["endpoint_mode='guessed'", "token_limit_parameter='unlimited'", 'temperature=-1', 'temperature=2.1', "temperature='NaN'", "temperature='Infinity'"]) {
      await assert.rejects(migration.query(`UPDATE spec_board_bots SET ${assignment} WHERE name='existing-bot'`), { code: '23514' })
    }
    await installEditorFunctions(migration)
    await recordSchema(migration)
    await grantRuntime(migration, runtime, { editorRole })
    assert.equal((await publicationGuard(migration)).ready, true)
    service = new Pool({ connectionString, options: `-c role=${runtime} -c search_path=${board},${editor}`, max: 2 })
    editorDb = new Pool({ connectionString, options: `-c role=${editorRole} -c search_path=${editor},${board}`, max: 1 })
    await verifyRuntime(service)
    for (const column of ['endpoint_mode', 'temperature', 'token_limit_parameter']) {
      await migration.query(`ALTER TABLE spec_board_bots RENAME COLUMN ${column} TO withheld_setting`)
      try { await assert.rejects(verifyRuntime(service), new RegExp(`missing spec_board_bots\\.${column}`)) }
      finally { await migration.query(`ALTER TABLE spec_board_bots RENAME COLUMN withheld_setting TO ${column}`) }
    }
    const bot = { name: 'configured-bot', url: 'https://model.example', model: 'example', apiKey: 'fixture-key',
      prompt: null, namespaces: ['team/specs'], enabled: true, clearKey: false, responseFormat: 'json_object', reasoningEffort: 'none',
      endpointMode: 'full', temperature: null, tokenLimitParameter: 'max_completion_tokens' }
    const save = async input => {
      const db = await service.connect()
      try {
        await db.query('BEGIN')
        await fixture.exports.saveBot(db, input, { subject: '42' })
        await db.query('COMMIT')
      } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
    }
    const storedBot = async () => (await fixture.exports.loadBots()).find(row => row.name === bot.name)
    await save(bot)
    assert.deepEqual((await fixture.exports.loadBots()).map(row => row.name), ['configured-bot', 'existing-bot'])
    await migration.query("UPDATE spec_board_bots SET token_hash='replacement-token' WHERE name='configured-bot'")
    assert.deepEqual((await fixture.exports.loadBots()).map(row => row.name), ['configured-bot', 'existing-bot'],
      'changing a token cannot change which enabled bot is first')
    await save({ ...bot, name: 'neta', apiKey: null })
    await save({ ...bot, name: 'net-b', apiKey: null })
    assert.deepEqual((await fixture.exports.loadBots()).map(row => row.name),
      ['configured-bot', 'existing-bot', 'net-b', 'neta'], 'bot selection uses byte order regardless of database collation')
    let persistedBot = await storedBot()
    assert.equal(persistedBot.response_format, 'json_object')
    assert.equal(persistedBot.reasoning_effort, 'none')
    assert.equal(persistedBot.endpoint_mode, 'full')
    assert.equal(persistedBot.temperature, null)
    assert.equal(persistedBot.token_limit_parameter, 'max_completion_tokens')
    const encryptedKey = persistedBot.api_key
    assert.notEqual(encryptedKey, bot.apiKey)
    await save({ ...bot, apiKey: null })
    assert.equal((await storedBot()).api_key, encryptedKey)
    const rendered = (await fixture.exports.listBotsForForm()).find(row => row.name === bot.name)
    assert.equal(rendered.response_format, 'json_object')
    assert.equal(rendered.reasoning_effort, 'none')
    assert.equal(rendered.endpoint_mode, 'full')
    assert.equal(rendered.temperature, null)
    assert.equal(rendered.token_limit_parameter, 'max_completion_tokens')
    assert.equal(rendered.has_key, true)
    assert.equal(Object.hasOwn(rendered, 'api_key'), false)
    await save({ ...bot, apiKey: null, temperature: 0, tokenLimitParameter: 'max_tokens' })
    assert.equal((await storedBot()).temperature, 0)
    assert.equal((await storedBot()).api_key, encryptedKey, 'request parameters retain the key')
    await save({ ...bot, apiKey: null, endpointMode: 'base' })
    assert.equal((await storedBot()).api_key, null, 'mode-only changes clear the key')
    await save({ ...bot, endpointMode: 'full', apiKey: 'mode-replacement-fixture-key' })
    assert.equal(require('./model-credentials').decryptSecret((await storedBot()).api_key, bot.name), 'mode-replacement-fixture-key')
    await save({ ...bot, url: 'https://other-model.example', apiKey: null })
    assert.equal((await storedBot()).api_key, null, 'a stored key must not follow an endpoint change')
    await save({ ...bot, url: 'https://replacement-model.example', apiKey: 'replacement-fixture-key' })
    assert.equal(require('./model-credentials').decryptSecret((await storedBot()).api_key, bot.name), 'replacement-fixture-key')
    await save({ ...bot, url: 'https://other-model.example', apiKey: 'ignored-fixture-key', clearKey: true, responseFormat: 'json_schema', reasoningEffort: null })
    persistedBot = await storedBot()
    assert.equal(persistedBot.api_key, null)
    assert.equal(persistedBot.response_format, 'json_schema')
    assert.equal(persistedBot.reasoning_effort, null)
    const events = (await service.query("SELECT evidence FROM spec_board_governance_events WHERE note_id='@bots' ORDER BY id")).rows
    assert.equal(events[0].evidence.responseFormat, 'json_object')
    assert.equal(events[0].evidence.reasoningEffort, 'none')
    assert.equal(events[0].evidence.endpointMode, 'full')
    assert.equal(events[0].evidence.temperature, null)
    assert.equal(events[0].evidence.tokenLimitParameter, 'max_completion_tokens')
    assert.equal(events[0].evidence.keyPresent, true)
    assert.equal(events.at(-1).evidence.keyPresent, false)
    assert.ok(!JSON.stringify(events).includes('fixture-key'))
    await admin.query(`GRANT TRIGGER ON ${editor}."Users" TO ${runtime}`)
    try {
      await assert.rejects(verifyRuntime(service), /privileges are excessive/)
    } finally {
      await admin.query(`REVOKE TRIGGER ON ${editor}."Users" FROM ${runtime}`)
    }
    await verifyRuntime(service)
    assert.equal((await publicationGuard(service, { migrate: false })).ready, true)
    await feedbackRetention(migration, service, editorDb)
    for (const privilege of ['UPDATE(extra)', 'DELETE', 'TRUNCATE', 'TRIGGER']) {
      await migration.query(`GRANT ${privilege} ON spec_board_feedback_decisions TO ${runtime}`)
      try {
        await assert.rejects(verifyRuntime(service), /privileges are excessive/, `${privilege} violates decision immutability`)
      } finally {
        await migration.query(`REVOKE ${privilege} ON spec_board_feedback_decisions FROM ${runtime}`)
      }
    }
    await migration.query(`REVOKE EXECUTE ON FUNCTION specdoc_purge_feedback_reasons() FROM ${runtime}`)
    try {
      await assert.rejects(verifyRuntime(service), /cannot call specdoc_purge_feedback_reasons/)
    } finally {
      await migration.query(`GRANT EXECUTE ON FUNCTION specdoc_purge_feedback_reasons() TO ${runtime}`)
    }
    await verifyRuntime(service)
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
    await editorTempTypes(migration, service, board, runtime)
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
    await migration.query('UPDATE spec_board_schema SET version=3')
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
