'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Pool } = require('pg')
const { planRedaction, redactHistory } = require('./history-redaction')
const { digest } = require('./publication-candidate')
const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const schema = 'redaction_' + crypto.randomBytes(10).toString('hex')
  const role = schema + '_runtime'
  const admin = new Pool({ connectionString, max: 1 })
  let db, runtime
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`CREATE ROLE ${role}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 })
    await db.query('CREATE TABLE "Notes"(id uuid PRIMARY KEY,shortid text UNIQUE,content text,permission text,"savedAt" timestamptz)')
    await db.query('CREATE TABLE "Users"(id text PRIMARY KEY,profile text,profileid text,email text)')
    await db.query('CREATE TABLE "Revisions"(id uuid PRIMARY KEY,"noteId" uuid,patch text,content text)')
    await db.query('CREATE TABLE "PublicOperations"(id uuid PRIMARY KEY,"noteId" uuid,result jsonb)')
    const file = path.join(__dirname, 'server.js')
    const fixture = new Module(file + '.redaction-test', module)
    fixture.filename = file
    fixture.paths = Module._nodeModulePaths(__dirname)
    const realRequire = fixture.require.bind(fixture)
    fixture.require = id => id === 'pg' ? { Pool: class { constructor () { return db } } } : realRequire(id)
    fixture._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.ensureState=ensureState;', file)
    const api = fixture.exports
    await api.ensureState()
    const first = crypto.randomUUID(), other = crypto.randomUUID(), untouched = crypto.randomUUID()
    const sensitive = 'Historical sensitive fixture text', bodyHash = digest(sensitive)
    await db.query(`INSERT INTO "Notes" VALUES ($1,'first','Corrected first','editable',now()),($2,'other','Corrected other','editable',now()),($3,'untouched','Unchanged','editable',now())`, [first, other, untouched])
    await db.query('INSERT INTO "Revisions" VALUES($1,$2,$3,$3),($4,$5,$3,$3)', [crypto.randomUUID(), first, sensitive, crypto.randomUUID(), untouched])
    await db.query('INSERT INTO "PublicOperations" VALUES($1,$2,$3)', [crypto.randomUUID(), first, JSON.stringify({ title: sensitive })])
    const thread = (await db.query(`INSERT INTO spec_board_review_threads(note_id,starter_subject,starter_login)
      VALUES('first','42','reviewer') RETURNING id`)).rows[0].id
    const message = (await db.query(`INSERT INTO spec_board_review_messages(note_id,thread_id,actor_subject,actor_login,body)
      VALUES('first',$1,'42','reviewer',$2) RETURNING *`, [thread, sensitive])).rows[0]
    const reviewEvent = (await db.query(`INSERT INTO spec_board_review_events(note_id,actor_subject,actor_login,action,thread_id,message_id,thread_version)
      VALUES('first','42','reviewer','thread',$1,$2,1) RETURNING *`, [thread, message.id])).rows[0]
    await api.withTx(client => api.takeSnapshot('first', 'approval', 'reviewer', sensitive, bodyHash, client), db)
    await api.withTx(client => api.takeSnapshot('other', 'published', 'r1', sensitive, bodyHash, client), db)
    const intentId = crypto.randomUUID()
    await db.query(`INSERT INTO spec_board_publication_intents
      (id,note_id,namespace,candidate_hash,policy_hash,revision,candidate,approvals,relations,document,document_hash,spec,identities,branch)
      VALUES($1,'first','team/specs',$2,'policy',0,$3,'[{"subject":"42"}]','{}',$4,$2,$3,'{}','branch')`, [intentId, bodyHash, JSON.stringify({ content: sensitive }), sensitive])
    await db.query(`INSERT INTO spec_board_governance_events(note_id,actor,action,evidence,body_hash)
      VALUES('first','github:42','publication-authorized','{"submission":"retained"}',$1)`, [bodyHash])
    const derived = []
    for (const [kind, sources] of [['map', ['first', 'untouched']], ['checkpoint', ['first']], ['map', ['untouched']]]) {
      const payload = kind === 'map' ? { document: sensitive, documentHash: bodyHash, path: 'specs/README.md', branch: 'map-fixture' }
        : { message: sensitive, messageHash: bodyHash, tag: 'checkpoint-fixture' }
      const evidence = { ...payload, namespace: 'team/specs', head: 'a'.repeat(40), sources: sources.map(noteId => ({ noteId, candidate: bodyHash })) }
      derived.push((await db.query(`INSERT INTO spec_board_governance_events(note_id,actor,action,evidence)
        VALUES($1,'github:42',$2,$3) RETURNING *`, [`${kind}:team/specs`, `${kind}-authorized`, JSON.stringify(evidence)])).rows[0])
    }
    await db.query(`INSERT INTO spec_board_notifications(email,note_id,title,line) VALUES('user@example.test','first',$1,$1),('user@example.test','untouched','untouched','untouched')`, [sensitive])
    await db.query(`INSERT INTO spec_board_conflicts(note_id,bot_name,peer_n,quote,why) VALUES('first','bot',1,$1,$1)`, [sensitive])
    await db.query(`INSERT INTO spec_board_operations(actor,key,fingerprint,note_id,note_uuid,endpoint,prepared,result,expires_at)
      VALUES('github:42',$1,'hash','first',$2,'reply',$3,$3,now()+interval '1 day')`, [crypto.randomUUID(), first, JSON.stringify({ content: sensitive })])
    const job = (await db.query("INSERT INTO spec_board_feedback_jobs(namespace,repo,number) VALUES('team/specs','team/code',1) RETURNING id")).rows[0].id
    await db.query(`INSERT INTO spec_board_feedback_proposals(job_id,target_note,target_namespace,group_id,source_hash,payload)
      VALUES($1,'first','team/specs','group','hash',$2)`, [job, JSON.stringify({ quote: sensitive })])
    await db.query(`INSERT INTO spec_board_feedback_runs(job_id,hash,generation,source_hash,proposal_count,payload) VALUES($1,'hash',1,'source',1,$2)`, [job, JSON.stringify({ quote: sensitive })])
    const originalReceipt = (await db.query('SELECT * FROM spec_board_governance_events ORDER BY id')).rows[0]
    const dry = await planRedaction(db, ['first'])
    assert.equal(dry.discussion_messages, 1)
    assert.deepEqual(dry.sharedWith, ['other'])
    assert.deepEqual(dry.derivedArtifacts.map(row => row.id), derived.slice(0, 2).map(row => row.id))
    assert.equal(JSON.stringify(dry).includes(sensitive), false)
    const options = { notes: ['first', 'other'], offline: true, actor: '42', reason: 'Credential incident cleanup', expectedHashes: { first: digest('Corrected first'), other: digest('Corrected other') } }
    await assert.rejects(redactHistory(db, { ...options, offline: false }), /Stop the board and editor/)
    await assert.rejects(redactHistory(db, { ...options, notes: ['first'] }), /shared with other notes/)
    await assert.rejects(redactHistory(db, { ...options, expectedHashes: {} }), /expected hash is missing/)
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`)
    runtime = new Pool({ connectionString, options: `-c role=${role} -c search_path=${schema}`, max: 1 })
    await assert.rejects(redactHistory(runtime, options), /offline database owner credential/)
    await db.query(`CREATE FUNCTION reject_redaction_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='history-redacted' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`)
    await db.query('CREATE TRIGGER reject_redaction_audit BEFORE INSERT ON spec_board_governance_events FOR EACH ROW EXECUTE FUNCTION reject_redaction_audit()')
    await assert.rejects(redactHistory(db, options), /fixture audit failure/)
    assert.equal((await db.query('SELECT body FROM spec_board_snapshot_bodies WHERE hash=$1', [bodyHash])).rows[0].body, sensitive, 'failed audit rolls back redaction')
    assert.deepEqual((await db.query('SELECT * FROM spec_board_review_messages WHERE id=$1', [message.id])).rows[0], message,
      'failed audit preserves discussion text')
    assert.deepEqual((await db.query('SELECT * FROM spec_board_governance_events WHERE id=$1', [derived[0].id])).rows[0], derived[0], 'failed audit preserves derived authorization payloads')
    await assert.rejects(db.query("UPDATE spec_board_publication_intents SET document='forged'"), /immutable/, 'rollback restores immutable trigger')
    await db.query('DROP TRIGGER reject_redaction_audit ON spec_board_governance_events')
    const applied = await redactHistory(db, options)
    assert.equal(applied.applied, true)
    assert.deepEqual((await db.query('SELECT shortid,content,permission FROM "Notes" ORDER BY shortid')).rows,
      [{ shortid: 'first', content: 'Corrected first', permission: 'private' }, { shortid: 'other', content: 'Corrected other', permission: 'private' }, { shortid: 'untouched', content: 'Unchanged', permission: 'editable' }])
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "Revisions" WHERE "noteId"=$1', [first])).rows[0].n, 0)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM "Revisions" WHERE "noteId"=$1', [untouched])).rows[0].n, 1)
    const body = (await db.query('SELECT * FROM spec_board_snapshot_bodies WHERE hash=$1', [bodyHash])).rows[0]
    assert.equal(body.body, '')
    assert.ok(body.redacted_at)
    const snapshot = (await db.query("SELECT id FROM spec_board_snapshots WHERE note_id='first'")).rows[0]
    await assert.rejects(api.snapshotBody(snapshot.id, db), { status: 410 })
    await api.withTx(client => api.takeSnapshot('first', 'approval', 'reviewer', sensitive, bodyHash, client), db)
    await assert.rejects(api.snapshotBody(snapshot.id, db), { status: 410 }, 'reintroducing the hash cannot restore redacted text')
    const intent = (await db.query('SELECT * FROM spec_board_publication_intents WHERE id=$1', [intentId])).rows[0]
    assert.equal(intent.document, '')
    assert.equal(intent.document_hash, bodyHash)
    assert.equal(intent.candidate_hash, bodyHash)
    assert.deepEqual(intent.approvals, [{ subject: '42' }])
    assert.ok(intent.redacted_at)
    await assert.rejects(db.query("UPDATE spec_board_publication_intents SET document='forged'"), /immutable/)
    assert.deepEqual((await db.query('SELECT * FROM spec_board_governance_events WHERE id=$1', [originalReceipt.id])).rows[0], originalReceipt)
    for (const original of derived.slice(0, 2)) {
      const saved = (await db.query('SELECT * FROM spec_board_governance_events WHERE id=$1', [original.id])).rows[0]
      const { message, document, ...retained } = original.evidence
      const { redacted, redactedAt, ...evidence } = saved.evidence
      assert.equal(redacted, true)
      assert.ok(redactedAt)
      assert.deepEqual(evidence, retained, 'derived hashes, source identities and cutoff destination stay intact')
      assert.deepEqual({ ...saved, evidence: original.evidence }, original, 'audit row identity and timestamp stay intact')
    }
    assert.deepEqual((await db.query('SELECT * FROM spec_board_governance_events WHERE id=$1', [derived[2].id])).rows[0], derived[2], 'unrelated artifact receipts are untouched')
    assert.equal((await db.query("SELECT count(*)::int AS n FROM spec_board_governance_events WHERE action='history-redacted'")).rows[0].n, 2)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM spec_board_moderation_notes WHERE state='hidden'")).rows[0].n, 2)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM spec_board_notifications WHERE note_id='first'")).rows[0].n, 0)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM spec_board_notifications WHERE note_id='untouched'")).rows[0].n, 1)
    assert.equal((await db.query('SELECT result FROM "PublicOperations"')).rows[0].result, null)
    assert.deepEqual((await db.query('SELECT prepared,result,expired FROM spec_board_operations')).rows[0], { prepared: null, result: null, expired: true })
    assert.equal((await db.query('SELECT payload FROM spec_board_feedback_proposals')).rows[0].payload, null)
    assert.equal((await db.query('SELECT payload FROM spec_board_feedback_runs')).rows[0].payload, null)
    assert.deepEqual((await db.query('SELECT * FROM spec_board_review_messages WHERE id=$1', [message.id])).rows[0],
      { ...message, body: '[Message removed during history redaction.]' }, 'redaction preserves message identity and removes text')
    assert.deepEqual((await db.query('SELECT * FROM spec_board_review_events WHERE id=$1', [reviewEvent.id])).rows[0], reviewEvent,
      'discussion audit identity remains intact')
    console.log('Offline scoped redaction, shared-body scope, expected text, owner-only access, audit rollback and immutable tombstones passed')
  } finally {
    if (runtime) await runtime.end()
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
