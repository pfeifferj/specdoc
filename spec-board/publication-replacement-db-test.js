'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Pool } = require('pg')
const intents = require('./publication-intent')
const { candidate } = require('./publication-candidate')
const { supersedePendingPublication, pendingInitialIntents } = require('./publication-replacement')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to a disposable PostgreSQL database.'); process.exit(1) }

async function main () {
  const schema = 'publication_replacement_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 5 })
    await db.query(`CREATE TABLE spec_board_state(note_id text PRIMARY KEY,namespace text,pr_number integer,
      pr_state text,spec_path text,published_hash text,published_commit text,implemented_at timestamptz,
      revision integer,revision_pr integer,publication_generation bigint NOT NULL DEFAULT 0)`)
    await db.query('CREATE TABLE spec_board_snapshots(id integer)')
    await intents.migrate(db)
    await db.query('ALTER TABLE spec_board_publication_intents ADD UNIQUE (note_id,candidate_hash,revision)')
    await intents.migrate(db)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='spec_board_publication_intents'::regclass AND contype='u'")).rows[0].n, 0,
      'migration removes the original constraint using its columns, including PostgreSQL-truncated names')
    await db.query("INSERT INTO spec_board_state(note_id,namespace) VALUES ('note','team/specs')")
    const tx = async fn => {
      const client = await db.connect()
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value } catch (error) {
        await client.query('ROLLBACK'); throw error
      } finally { client.release() }
    }
    const spec = text => ({ id: 'note', namespace: 'team/specs', title: 'Requirement', permission: 'editable',
      ownerSubject: '10', publicationBody: text, roles: { authors: ['10'], approvers: ['42'], 'approvals-required': 1 } })
    const create = text => tx(client => intents.createIntent(client, spec(text), candidate(spec(text), text), [], {}))
    const first = await create('A')
    const pending = await Promise.all([create('B'), create('B'), create('B')])
    assert.equal(new Set(pending.map(row => row.id)).size, 1, 'concurrent retries share one active intent')
    const next = pending[0]
    await db.query("UPDATE spec_board_publication_intents SET pr_number=1,path='specs/001.md',base_sha=$2,base_branch='main' WHERE id=$1", [first.id, 'a'.repeat(40)])
    first.pr_number = 1
    const setPrevious = () => db.query(`UPDATE spec_board_state SET namespace='team/specs',pr_number=1,pr_state='open',published_hash=$1,
      published_candidate_hash=$2,published_commit=NULL,publication_receipt=NULL,publication_generation=5 WHERE note_id='note'`, [first.document_hash, first.candidate_hash])
    const closed = { submission: first.id, namespace: first.namespace, number: 1, head: 'b'.repeat(40) }
    const replace = generation => tx(client => supersedePendingPublication(client, first, next, generation, closed))
    await setPrevious()
    assert.equal((await replace(4)).applied, false, 'an older worker cannot reset the current publication')
    assert.equal((await db.query("SELECT count(*)::int AS n FROM spec_board_governance_events WHERE action='publication-superseded'")).rows[0].n, 0)
    for (const change of ["pr_state='merged'", "published_commit='merged'", "publication_receipt='{}'::jsonb", "pr_number=2", "namespace='other/specs'"]) {
      await setPrevious()
      await db.query('UPDATE spec_board_state SET ' + change + " WHERE note_id='note'")
      await assert.rejects(replace(5), /verified unmerged/)
    }
    await db.query("UPDATE spec_board_state SET namespace='team/specs' WHERE note_id='note'")
    await setPrevious()
    const blocker = await db.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query("SELECT * FROM spec_board_state WHERE note_id='note' FOR UPDATE")
      const waiting = replace(5)
      await blocker.query("UPDATE spec_board_state SET publication_generation=6 WHERE note_id='note'")
      await blocker.query('COMMIT')
      assert.equal((await waiting).applied, false, 'a claim committed while replacement waits wins')
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    await setPrevious()
    const replaced = await replace(5)
    assert.equal(replaced.applied, true)
    assert.equal(replaced.state.pr_number, null)
    const event = (await db.query("SELECT evidence FROM spec_board_governance_events WHERE action='publication-superseded'")).rows[0].evidence
    assert.equal(event.submission, first.id)
    assert.equal(event.replacement, next.id)
    assert.equal((await db.query('SELECT document FROM spec_board_publication_intents WHERE id=$1', [first.id])).rows[0].document, first.document)
    assert.deepEqual(await pendingInitialIntents(db, 'note'), [], 'recovery after closing cannot restore the superseded PR')
    await db.query("UPDATE spec_board_publication_intents SET pr_number=2,path='specs/002.md',base_sha=$2,base_branch='main' WHERE id=$1", [next.id, 'a'.repeat(40)])
    assert.deepEqual((await pendingInitialIntents(db, 'note')).map(row => row.id), [next.id], 'a lost replacement response recovers only the new submission')
    const reverted = await create('A')
    assert.notEqual(reverted.id, first.id, 'reapproving a superseded candidate creates a fresh submission')
    assert.equal((await create('A')).id, reverted.id, 'retrying the fresh candidate resumes it')
    await assert.rejects(tx(client => intents.createIntent(client, { ...spec('A'), id: 'missing' }, candidate(spec('A'), 'A'), [], {})), /Publication state is required/)
    console.log('pending publication replacement database checks passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
