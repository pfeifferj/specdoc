const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { takeSnapshot, snapshotPlan, applySnapshotPlan, snapshotBody, migrateSnapshotIntegrity, withTx, currentPublicNote } = require('./server')
const connectionString = process.env.SNAPSHOTS_TEST_DATABASE_URL
if (!connectionString) { console.error('Set SNAPSHOTS_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const schema = 'snapshots_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db, writer, collector
  let committed = false
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4, statement_timeout: 5000 })
    await db.query('CREATE TABLE spec_board_snapshot_bodies (hash text PRIMARY KEY, body text NOT NULL)')
    await db.query(`CREATE TABLE spec_board_snapshots (id serial PRIMARY KEY, note_id text NOT NULL,
      kind text NOT NULL, label text NOT NULL CHECK (label <> 'reject'), hash text NOT NULL,
      notified_hash text, taken_at timestamptz DEFAULT now())`)
    await db.query(`CREATE UNIQUE INDEX spec_board_snapshots_one
      ON spec_board_snapshots (note_id, kind, lower(label)) WHERE kind <> 'status'`)
    const { rows: legacy } = await db.query("INSERT INTO spec_board_snapshots (note_id,kind,label,hash) VALUES ('legacy','approval','alice','missing') RETURNING id")
    await migrateSnapshotIntegrity(db)
    await migrateSnapshotIntegrity(db)
    await assert.rejects(snapshotBody(legacy[0].id, db), /no stored text/)
    await assert.rejects(db.query("INSERT INTO spec_board_snapshots (note_id,kind,label,hash) VALUES ('new','approval','alice','missing')"), { code: '23503' })
    await assert.rejects(withTx(client => takeSnapshot('a', 'approval', 'reject', 'rolled back', 'rollback', client), db), { code: '23514' })
    assert.equal((await db.query("SELECT 1 FROM spec_board_snapshot_bodies WHERE hash='rollback'")).rowCount, 0)

    await db.query("INSERT INTO spec_board_snapshot_bodies VALUES ('shared','Approved text')")
    writer = await db.connect()
    collector = await db.connect()
    const { rows: [{ pid }] } = await collector.query('SELECT pg_backend_pid() AS pid')
    await writer.query('BEGIN')
    const saved = await takeSnapshot('a', 'approval', 'alice', 'Approved text', 'shared', writer)
    const sweep = collector.query(`DELETE FROM spec_board_snapshot_bodies b
      WHERE NOT EXISTS (SELECT 1 FROM spec_board_snapshots s WHERE s.hash=b.hash)`)
      .then(result => ({ result }), error => ({ error }))
    let waiting = false
    for (let i = 0; i < 100; i++) {
      const { rows } = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])
      if (rows[0].wait_event_type === 'Lock') { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(waiting, true, 'GC waits while approval pins a reused body')
    await writer.query('COMMIT')
    committed = true
    const outcome = await sweep
    assert.equal(outcome.error && outcome.error.code, '23503')
    assert.equal(await snapshotBody(saved.id, db), 'Approved text')
    await db.query(`DELETE FROM spec_board_snapshot_bodies b
      WHERE NOT EXISTS (SELECT 1 FROM spec_board_snapshots s WHERE s.hash=b.hash)`)
    assert.equal(await snapshotBody(saved.id, db), 'Approved text')

    const legacyPlan = snapshotPlan({ status: 'approved', prevStatus: 'approved', rows: [],
      hash: 'legacy-hash', publishedHash: 'legacy-hash', revision: 2 })
    const backfilled = await applySnapshotPlan('missing-history', [], legacyPlan, 'Legacy published text', 'legacy-hash', db)
    assert.equal(backfilled.length, 1)
    assert.equal(await snapshotBody(backfilled[0].id, db), 'Legacy published text', 'missing published history is still backfilled')

    await writer.query('BEGIN')
    committed = false
    const recovered = await takeSnapshot('racing-history', 'published', 'r2', 'Newer merged text', 'merged-hash', writer)
    await writer.query("UPDATE spec_board_snapshots SET notified_hash='already-notified' WHERE id=$1", [recovered.id])
    let backfillPid = null
    const backfillDb = {
      async connect () {
        const client = await db.connect()
        backfillPid = client.processID
        return client
      },
      query: (...args) => db.query(...args)
    }
    const delayedBackfill = applySnapshotPlan('racing-history', [], legacyPlan, 'Legacy published text', 'legacy-hash', backfillDb)
      .then(result => ({ result }), error => ({ error }))
    waiting = false
    for (let i = 0; i < 100; i++) {
      if (backfillPid !== null) {
        const { rows } = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [backfillPid])
        if (rows[0].wait_event_type === 'Lock') { waiting = true; break }
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(waiting, true, 'the old backfill waits for the newer recovery transaction')
    await writer.query('COMMIT')
    committed = true
    const backfillOutcome = await delayedBackfill
    assert.equal(backfillOutcome.error, undefined)
    assert.deepEqual(backfillOutcome.result, [{ ...recovered, notified_hash: 'already-notified' }],
      'the delayed backfill preserves the newer label, hash, timestamp and notification marker')
    assert.equal(await snapshotBody(recovered.id, db), 'Newer merged text')
    const corrected = await withTx(client => takeSnapshot('racing-history', 'published', 'r2',
      'Explicitly recovered correction', 'corrected-hash', client), db)
    assert.equal(corrected.id, recovered.id)
    assert.equal(corrected.notified_hash, null)
    assert.equal(await snapshotBody(recovered.id, db), 'Explicitly recovered correction',
      'explicit publication completion can still replace an existing snapshot')

    await db.query('CREATE TABLE "Notes" (shortid text PRIMARY KEY, permission text)')
    for (const permission of ['freely', 'editable', 'locked', null, 'private', 'limited', 'protected', 'unknown']) {
      await db.query('INSERT INTO "Notes" VALUES ($1,$2) ON CONFLICT (shortid) DO UPDATE SET permission=$2', ['a', permission])
      assert.equal(await currentPublicNote('a', db), [null, 'freely', 'editable', 'locked'].includes(permission))
    }
    assert.equal(await currentPublicNote('deleted', db), false)
    console.log('snapshot database tests passed')
  } finally {
    if (writer) {
      if (!committed) await writer.query('ROLLBACK').catch(() => {})
      writer.release()
    }
    if (collector) collector.release()
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
