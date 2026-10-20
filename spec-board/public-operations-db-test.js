const assert = require('assert/strict')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { Pool } = require('pg')
const { migrate, createOperations, fingerprint } = require('./public-operations')
const { contentHash } = require('./editor-client')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) {
  console.error('Set AUDIT_TEST_DATABASE_URL to an explicit disposable PostgreSQL test database.')
  process.exit(1)
}
const error = (status, message) => Object.assign(new Error(message), { status })

function fixture (db, mode = 'normal') {
  const authorize = async id => {
    const { rows: [note] } = await db.query('SELECT permission FROM "Notes" WHERE shortid=$1', [id])
    if (!note || note.permission !== 'editable') throw error(404, 'Unknown note')
  }
  const ops = createOperations({ db, mutate: async mutation => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const { rows: [note] } = await client.query('SELECT * FROM "Notes" WHERE shortid=$1 FOR UPDATE', [mutation.noteId])
      const { rows: [receipt] } = await client.query('SELECT 1 FROM editor_receipts WHERE id=$1', [mutation.operationId])
      if (!receipt) {
        if (contentHash(note.content) !== mutation.expectedHash) throw error(412, 'Stale mutation')
        await client.query('UPDATE "Notes" SET content=$1 WHERE shortid=$2', [mutation.content, mutation.noteId])
        await client.query('INSERT INTO editor_receipts VALUES ($1)', [mutation.operationId])
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
    if (mode === 'crash') process.exit(77)
    if (mode === 'lost') throw new Error('Response lost')
  } })
  const request = (key, base, extra = '') => ({
    actor: 'actor', key, noteId: 'note-one', endpoint: '/replies',
    requestFingerprint: fingerprint({ base, extra }), authorize,
    prepare: async () => {
      const { rows: [note] } = await db.query('SELECT * FROM "Notes" WHERE shortid=$1', ['note-one'])
      if (contentHash(note.content) !== contentHash(base)) throw error(409, 'Stale request')
      return {
        mutation: { operationId: crypto.randomUUID(), noteId: 'note-one', expectedHash: contentHash(base), content: base + ' reply' },
        result: { key, written: true, hash: contentHash(base + ' reply') }
      }
    }
  })
  return { ops, request, authorize }
}

async function worker () {
  const [, , , schema, key, base, mode] = process.argv
  const db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
  try {
    const f = fixture(db, mode)
    const result = await f.ops.run(f.request(key, base))
    process.stdout.write(JSON.stringify(result))
  } finally { await db.end() }
}

function child (schema, key, base, mode = 'normal') {
  return new Promise((resolve, reject) => {
    const process = spawn(global.process.execPath, [__filename, 'worker', schema, key, base, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    process.stdout.on('data', data => { stdout += data })
    process.stderr.on('data', data => { stderr += data })
    process.on('error', reject)
    process.on('close', code => {
      if (code === 77 && mode === 'crash') return resolve(null)
      if (code !== 0) return reject(new Error(stderr || 'worker failed: ' + code))
      resolve(JSON.parse(stdout))
    })
  })
}

async function main () {
  const schema = 'public_operations_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
    await db.query('CREATE TABLE "Notes" (id uuid PRIMARY KEY, shortid text UNIQUE, content text, permission text)')
    await db.query('CREATE TABLE editor_receipts (id uuid PRIMARY KEY)')
    await migrate(db)
    await db.query('INSERT INTO "Notes" VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), 'note-one', 'base', 'editable'])
    const current = async () => (await db.query('SELECT content FROM "Notes"')).rows[0].content
    const f = fixture(db)

    const concurrentKey = crypto.randomUUID()
    const concurrent = await Promise.all([child(schema, concurrentKey, 'base'), child(schema, concurrentKey, 'base')])
    assert.equal(await current(), 'base reply')
    assert.deepEqual(concurrent[0].result, concurrent[1].result)
    assert.equal(concurrent.filter(r => r.replayed).length, 1)
    await Promise.all(Array.from({ length: 16 }, () => f.ops.run(f.request(concurrentKey, 'base'))))
    await assert.rejects(f.ops.run(f.request(concurrentKey, 'base', 'changed')), { status: 409 })
    const receipt = await f.ops.get({ actor: 'actor', key: concurrentKey, authorize: f.authorize })
    assert.equal(receipt.state, 'completed')
    assert.equal(JSON.stringify(receipt).includes('base'), false, 'public receipt has no note text')
    assert.equal((await db.query('SELECT prepared FROM spec_board_operations WHERE key=$1', [concurrentKey])).rows[0].prepared, null)

    const crashedKey = crypto.randomUUID()
    await child(schema, crashedKey, 'base reply', 'crash')
    assert.equal(await current(), 'base reply reply')
    assert.equal((await f.ops.get({ actor: 'actor', key: crashedKey, authorize: f.authorize })).state, 'pending')
    const recovered = await child(schema, crashedKey, 'base reply')
    assert.equal(recovered.status, 200)
    assert.equal(await current(), 'base reply reply', 'restart replays immutable internal operation, despite stale original guard')
    assert.equal((await db.query('SELECT count(*)::int AS count FROM editor_receipts')).rows[0].count, 2)

    const lostKey = crypto.randomUUID()
    const lost = fixture(db, 'lost')
    await assert.rejects(lost.ops.run(lost.request(lostKey, 'base reply reply')), /Response lost/)
    await f.ops.run(f.request(lostKey, 'base reply reply'))
    assert.equal(await current(), 'base reply reply reply')

    await db.query('UPDATE "Notes" SET permission=$1', ['private'])
    await assert.rejects(f.ops.get({ actor: 'actor', key: concurrentKey, authorize: f.authorize }), { status: 404 })
    await assert.rejects(f.ops.run(f.request(concurrentKey, 'base')), { status: 404 })
    await db.query('UPDATE "Notes" SET permission=$1', ['editable'])
    await db.query("UPDATE spec_board_operations SET expires_at=now()-interval '1 second' WHERE key=$1", [concurrentKey])
    await assert.rejects(f.ops.run(f.request(concurrentKey, 'base')), { status: 410 })
    assert.equal((await db.query('SELECT result FROM spec_board_operations WHERE key=$1', [concurrentKey])).rows[0].result, null)

    const pendingKey = crypto.randomUUID()
    await assert.rejects(lost.ops.run(lost.request(pendingKey, await current())), /Response lost/)
    await db.query('DELETE FROM "Notes"')
    const { rows: [deleted] } = await db.query('SELECT prepared, expired, note_uuid FROM spec_board_operations WHERE key=$1', [pendingKey])
    assert.deepEqual(deleted, { prepared: null, expired: true, note_uuid: null })
    await db.query('INSERT INTO "Notes" VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), 'note-one', 'base', 'editable'])
    await assert.rejects(f.ops.run(f.request(concurrentKey, 'base')), { status: 410 })
    assert.equal(await current(), 'base', 'note ID reuse does not reactivate tombstones')
    console.log('public operation restart, concurrent process, recovery, visibility, expiry and deletion tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

(process.argv[2] === 'worker' ? worker() : main()).catch(error => {
  console.error(error)
  process.exitCode = 1
})
