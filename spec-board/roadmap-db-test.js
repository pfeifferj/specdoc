const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createRoadmapStore } = require('./roadmap-store')
const { milestoneInput } = require('./roadmap')
const connectionString = process.env.ROADMAP_TEST_DATABASE_URL
if (!connectionString) { console.error('Set ROADMAP_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
async function main () {
  const schema = 'roadmap_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let pool
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
    await pool.query('CREATE TABLE "Users" (id text PRIMARY KEY, profile text)')
    await pool.query('INSERT INTO "Users" (id, profile) VALUES ($1,$2),($3,$4)', ['u1', JSON.stringify({ username: 'alice', displayName: 'Alice' }), 'u2', JSON.stringify({ username: 'bob' })])
    const store = createRoadmapStore(pool)
    await store.migrate(); await store.migrate()
    const create = (title, namespace = 'o/r') => store.saveMilestone({ namespace, input: milestoneInput({ title, dueDate: '2028-02-29' }), checkpoint: null })
    const one = await create('One'), two = await create('Two'), other = await create('Other', 'other/r')
    assert.equal(one.dueDate, '2028-02-29')
    assert.deepEqual(await store.getMilestone(one.id, 'o/r'), one)
    assert.equal(await store.getMilestone(one.id, 'other/r'), null)
    const args = { noteId: 'a', namespace: 'o/r', action: 'milestone', expectedVersion: 0, milestoneId: one.id, actor: 'admin', validate: async () => {} }
    const race = await Promise.allSettled([store.saveAssignment(args), store.saveAssignment({ ...args, milestoneId: two.id })])
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(race.find(r => r.status === 'rejected').reason.status, 409)
    let [a] = (await store.read()).assignments
    assert.equal(a.version, 1)
    await assert.rejects(store.saveAssignment({ ...args, expectedVersion: 1, milestoneId: other.id }), /another namespace/)
    await store.saveAssignment({ ...args, expectedVersion: 1, milestoneId: null })
    await assert.rejects(store.saveAssignment(args), /changed/)
    await store.saveAssignment({ ...args, expectedVersion: 2, action: 'add-implementer', userId: 'u1' })
    await store.saveAssignment({ ...args, expectedVersion: 3, action: 'add-implementer', userId: 'u2' })
    await store.saveAssignment({ ...args, expectedVersion: 4, action: 'add-implementer', userId: 'u1' })
    ;[a] = (await store.read()).assignments
    assert.equal(a.milestoneId, null)
    assert.equal(a.implementers.length, 2)
    await pool.query('UPDATE "Users" SET profile=$1 WHERE id=$2', [JSON.stringify({ username: 'renamed' }), 'u1'])
    assert.equal((await store.read()).assignments[0].implementers.find(u => u.id === 'u1').login, 'renamed')
    await pool.query('DELETE FROM "Users" WHERE id=$1', ['u2'])
    assert.equal((await store.read()).assignments[0].implementers.length, 1)
    const update = { id: one.id, namespace: one.namespace, expectedVersion: 1, input: milestoneInput({ title: 'Closed', state: 'closed' }) }
    const edits = await Promise.allSettled([store.saveMilestone(update), store.saveMilestone(update)])
    assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1)
    await assert.rejects(store.saveAssignment({ ...args, expectedVersion: 5 }), /Reopen/)
    await store.saveAssignment({ ...args, expectedVersion: 5, namespace: 'other/r', milestoneId: other.id })
    ;[a] = (await store.read()).assignments
    assert.equal(a.namespace, 'other/r')
    assert.equal(a.implementers.length, 0)
    await assert.rejects(pool.query('UPDATE spec_board_planning SET milestone_id=$1 WHERE note_id=$2', [two.id, 'a']), /foreign key/)
    await assert.rejects(store.saveAssignment({ ...args, noteId: 'b', validate: async () => { throw new Error('private') } }), /private/)
    assert.equal((await store.read()).assignments.length, 1)
    const linked = await store.saveMilestone({ id: two.id, namespace: two.namespace, expectedVersion: 1, input: milestoneInput({ title: 'Linked', checkpointTag: 'specs/v1' }), checkpoint: { commit: 'a'.repeat(40) } })
    assert.equal(linked.checkpointCommit, 'a'.repeat(40))
    assert.ok(linked.checkpointLinkedAt)
    const renamed = await store.saveMilestone({ id: two.id, namespace: two.namespace, expectedVersion: linked.version,
      input: milestoneInput({ title: 'Renamed', checkpointTag: 'specs/v1' }), checkpoint: { commit: linked.checkpointCommit } })
    assert.equal(renamed.checkpointCommit, linked.checkpointCommit)
    assert.deepEqual(renamed.checkpointLinkedAt, linked.checkpointLinkedAt)
    assert.equal((await store.users('rename'))[0].id, 'u1')
    assert.equal((await store.users('%')).length, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM spec_board_planning_events')).rows[0].n, 6)
    console.log('roadmap database tests passed')
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
