const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { claimPublication, completePublication } = require('./publication-state')

const connectionString = process.env.AUDIT_TEST_DATABASE_URL
if (!connectionString) { console.error('Set AUDIT_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }

async function main () {
  const schema = 'publication_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let db
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    await db.query(`CREATE TABLE spec_board_state (note_id text PRIMARY KEY, namespace text,
      pr_number integer, pr_state text, category text, spec_path text, published_hash text,
      published_commit text, revision integer, revision_pr integer,
      publication_generation bigint NOT NULL DEFAULT 0)`)
    await db.query(`CREATE TABLE snapshots (note_id text, label text, body text, hash text,
      PRIMARY KEY (note_id, label))`)
    await db.query("CREATE TABLE outbox (line text CHECK (line <> 'reject this event'))")
    await db.query("INSERT INTO spec_board_state(note_id, namespace) VALUES ('note-one', 'team/specs')")
    const tx = async fn => {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        const result = await fn(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    }
    let allowed = true
    const guard = () => { if (!allowed) throw new Error('leadership lost') }
    const claim = () => tx(client => claimPublication(client, 'note-one', guard))
    const state = async () => (await db.query('SELECT * FROM spec_board_state')).rows[0]
    const counts = async () => (await db.query('SELECT (SELECT count(*)::integer FROM snapshots) AS snapshots, (SELECT count(*)::integer FROM outbox) AS events')).rows[0]
    const complete = (claimed, values, line = 'published') => tx(client =>
      completePublication(client, 'note-one', claimed.publication_generation, async (client, current) => {
        const next = { namespace: 'team/specs', pr_number: 42, pr_state: 'merged', category: 'area',
          spec_path: 'specs/area/042-spec.md', revision: 0, revision_pr: null, published_commit: 'original-merge',
          ...current, ...values }
        await client.query(`UPDATE spec_board_state SET namespace=$1, pr_number=$2, pr_state=$3,
          category=$4, spec_path=$5, published_hash=$6, published_commit=$7, revision=$8, revision_pr=$9
          WHERE note_id='note-one'`, [next.namespace, next.pr_number, next.pr_state, next.category,
          next.spec_path, next.published_hash, next.published_commit, next.revision, next.revision_pr])
        await client.query(`INSERT INTO snapshots VALUES ('note-one',$1,$2,$3)
          ON CONFLICT (note_id,label) DO UPDATE SET body=EXCLUDED.body, hash=EXCLUDED.hash`,
        ['r' + next.revision, 'body ' + next.published_hash, next.published_hash])
        await client.query('INSERT INTO outbox VALUES ($1)', [line])
        return next.published_hash
      }))

    const oldInitial = await claim()
    assert.equal(oldInitial.publication_generation, '1', 'legacy rows begin with generation zero')
    const newInitial = await claim()
    const initial = await complete(newInitial, { pr_number: 42, pr_state: 'merged', category: 'area',
      spec_path: 'specs/area/042-spec.md', published_hash: 'initial', published_commit: 'original-merge', revision: 0 })
    assert.equal(initial.applied, true)
    const oldResult = await complete(oldInitial, { pr_number: 99, published_hash: 'stale initial' })
    assert.equal(oldResult.applied, false)
    assert.equal(oldResult.state.pr_number, 42, 'losing caller receives the latest identity')
    assert.deepEqual(await counts(), { snapshots: 1, events: 1 }, 'a stale initial completion creates no snapshot or mail')

    const oldRevision = await claim()
    await complete(await claim(), { revision: 1, revision_pr: 43, published_hash: 'revision one' })
    await complete(await claim(), { revision: 2, revision_pr: 44, published_hash: 'revision two' })
    const beforeStale = await counts()
    assert.equal((await complete(oldRevision, { revision: 1, revision_pr: 43, published_hash: 'stale revision' })).applied, false)
    assert.equal((await state()).revision, 2)
    assert.equal((await state()).revision_pr, 44)
    assert.deepEqual(await counts(), beforeStale)

    const oldRecovery = await claim()
    await complete(await claim(), { published_commit: 'new-merge', published_hash: 'merged text' })
    assert.equal((await complete(oldRecovery, { published_commit: 'old-merge', published_hash: 'old text' })).applied, false)
    assert.equal((await state()).published_commit, 'new-merge')

    await complete(await claim(), { published_hash: 'A' })
    const beforeABA = await claim()
    await complete(await claim(), { published_hash: 'B' })
    await complete(await claim(), { published_hash: 'A' })
    const afterABA = await state()
    const withoutGeneration = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'publication_generation'))
    assert.deepEqual(withoutGeneration(afterABA), withoutGeneration(beforeABA), 'the complete publication tuple returned to its prior value')
    const beforeABACounts = await counts()
    assert.equal((await complete(beforeABA, { published_hash: 'late C' })).applied, false, 'generation detects same-revision ABA')
    assert.equal((await state()).published_hash, 'A')
    assert.deepEqual(await counts(), beforeABACounts)

    const finishing = await claim()
    allowed = false
    assert.equal((await complete(finishing, { published_hash: 'acknowledged during drain' })).applied, true)
    const beforeStoppedClaim = await state()
    await assert.rejects(claim(), /leadership lost/)
    assert.deepEqual(await state(), beforeStoppedClaim, 'shutdown prevents another claim while preserving acknowledged work')
    allowed = true

    const failed = await claim()
    const beforeFailure = await state()
    const beforeFailureCounts = await counts()
    await assert.rejects(complete(failed, { published_hash: 'rolled back' }, 'reject this event'), /check constraint/)
    assert.deepEqual(await state(), beforeFailure)
    assert.deepEqual(await counts(), beforeFailureCounts, 'state, snapshot and outbox roll back together')
    assert.equal((await complete(failed, { published_hash: 'retried acknowledgement' })).applied, true)

    const immutable = await claim()
    const beforeIdentityChange = await state()
    await assert.rejects(complete(immutable, { namespace: 'other/specs' }), /recorded namespace or PR identity/)
    await assert.rejects(complete(immutable, { pr_number: 99 }), /recorded namespace or PR identity/)
    assert.deepEqual(await state(), beforeIdentityChange)

    const parallel = await Promise.all([claim(), claim(), claim()])
    const generations = parallel.map(row => BigInt(row.publication_generation)).sort((a, b) => a < b ? -1 : 1)
    assert.equal(generations[2] - generations[0], 2n, 'concurrent claims serialize into distinct generations')
    const results = []
    for (const pending of parallel) results.push(await complete(pending, { published_hash: 'parallel winner' }))
    assert.equal(results.filter(result => result.applied).length, 1, 'only the newest concurrent claim can finish')
    console.log('publication generation database tests passed')
  } finally {
    if (db) await db.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
