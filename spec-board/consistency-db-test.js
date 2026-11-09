const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Pool } = require('pg')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) throw new Error('AUDIT_TEST_DATABASE_URL must identify a disposable test database')

function instance (db, connected = () => {}) {
  const file = path.join(__dirname, 'server.js')
  const loaded = new Module(file + '.consistency-db-test', module)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(fs.readFileSync(file, 'utf8') + `
    module.exports.lockFixture = {
      run: withConsistencyRun,
      connect: fn => { pool.connect = fn },
      close: () => pool.end()
    }
  `, file)
  const fixture = loaded.exports.lockFixture
  fixture.connect(async () => {
    const client = await db.connect()
    connected(client)
    return client
  })
  return fixture
}

function deferred () {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function within (promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Database lock check timed out')), 10000) })
    ])
  } finally { clearTimeout(timer) }
}

async function main () {
  const db = new Pool({ connectionString, max: 4 })
  const admin = new Pool({ connectionString, max: 1 })
  let ownerPid
  const first = instance(db, client => { ownerPid = client.processID })
  const second = instance(db)
  const ended = deferred()
  const acquireFailure = new Error('Query read timeout after the lock was granted')
  const uncertain = instance(db, client => {
    client.once('end', ended.resolve)
    const query = client.query.bind(client)
    client.query = async (...args) => {
      client.query = query
      const result = await query(...args)
      assert.equal(result.rows[0].locked, true)
      throw acquireFailure
    }
  })
  const unblock = deferred()
  const finishLost = deferred()
  let held, lost
  try {
    const started = deferred()
    held = first.run('lock-fixture/specs', async ({ signal }) => {
      assert.equal(signal.aborted, false)
      started.resolve()
      await unblock.promise
      return 'finished'
    })
    await within(started.promise)
    await assert.rejects(second.run('lock-fixture/specs', async () => assert.fail('A competing instance ran')), { code: 'consistency-busy' })
    await assert.rejects(first.run('lock-fixture/specs', async () => assert.fail('A duplicate local request ran')), { code: 'consistency-busy' })
    assert.equal(await second.run('other-fixture/specs', async () => 'independent'), 'independent')
    unblock.resolve()
    assert.equal(await within(held), 'finished')
    assert.equal(await second.run('lock-fixture/specs', async () => 'next run'), 'next run')

    const failure = new Error('The model failed')
    await assert.rejects(first.run('lock-fixture/specs', async () => { throw failure }), error => error === failure)
    assert.equal(await second.run('lock-fixture/specs', async () => 'after failure'), 'after failure')

    const connected = deferred()
    lost = first.run('lock-fixture/specs', async ({ signal }) => {
      connected.resolve()
      await Promise.race([
        new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
        finishLost.promise
      ])
      return 'must not report success after losing the lock'
    })
    const rejected = assert.rejects(lost, /terminat|connection/i)
    await within(connected.promise)
    assert.ok(Number.isInteger(ownerPid))
    await admin.query('SELECT pg_terminate_backend($1)', [ownerPid])
    await within(rejected)
    assert.equal(await second.run('lock-fixture/specs', async () => 'after disconnect'), 'after disconnect')
    assert.equal(await first.run('lock-fixture/specs', async () => 'reconnected'), 'reconnected')

    await assert.rejects(uncertain.run('uncertain-fixture/specs', async () => assert.fail('An uncertain lock started work')), error => error === acquireFailure)
    await within(ended.promise)
    assert.equal(await second.run('uncertain-fixture/specs', async () => 'after acquisition failure'), 'after acquisition failure')
    console.log('consistency locking: competing instances, release, connection loss and uncertain acquisition passed')
  } finally {
    unblock.resolve()
    finishLost.resolve()
    if (held) await held.catch(() => {})
    if (lost) await lost.catch(() => {})
    await Promise.all([first.close(), second.close(), uncertain.close(), db.end(), admin.end()])
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
