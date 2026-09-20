const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createFeedbackStore } = require('./feedback-store')

const connectionString = process.env.FEEDBACK_TEST_DATABASE_URL
if (!connectionString) {
  console.error('Set FEEDBACK_TEST_DATABASE_URL to an explicit PostgreSQL test database.')
  process.exit(1)
}

async function main () {
  const schema = 'feedback_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let pool
  let created = false
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    created = true
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema)
    let store = createFeedbackStore(pool)
    await store.migrate()
    await store.migrate()
    const actor = { uid: 'owner-1', login: 'owner' }
    const evidence = hash => ({ hash, mergedAt: new Date().toISOString(), sources: [{ id: 'comment:1', body: 'Persist the deadline.' }] })
    const proposal = (hash, extra = {}) => ({
      targetNote: 'note-one', targetNamespace: 'spec/project', groupId: 'thread:1',
      anchor: 'R1', quote: 'Keep the deadline.', amendment: 'Persist the deadline across restarts.',
      rationale: 'The implementation review identified restart behavior.', sourceIds: ['comment:1'],
      sourceHash: hash, canonical: { commit: 'commit-1', blob: 'blob-1', body: 'Keep the deadline.', hash: 'canonical-1', path: 'specs/001-deadline.md' },
      editorHash: 'editor-1', ...extra
    })
    const ready = async (number, hash = 'source-1', manual = false) => {
      const job = await store.enqueue('spec/project', 'code/project', number, manual)
      return store.saveEvidence(job, evidence(hash))
    }
    const publish = async (job, hash, runHash = 'run-1', changes = {}) => store.recordAnalysis(job, {
      runHash, evidence: evidence(hash), proposals: [proposal(hash)],
      settingsGeneration: (await store.settings(job.namespace)).generation, ...changes
    })
    const forJob = async job => (await pool.query('SELECT * FROM spec_board_feedback_proposals WHERE job_id = $1 ORDER BY id', [job.id])).rows

    assert.deepEqual(await store.settings('spec/project'), { enabled: true, generation: 0 })
    await store.saveScan('discovery', { cursor: '2026-09-01', page: 2 }, [
      { namespace: 'spec/project', repo: 'code/project', number: 1, updatedAt: '2026-09-01T00:00:00Z' }
    ])
    await store.saveScan('discovery', { cursor: '2026-09-01', page: 2 }, [
      { namespace: 'spec/project', repo: 'code/project', number: 1, updatedAt: '2026-09-01T00:00:00Z' }
    ])
    assert.equal((await store.due()).length, 1)
    await assert.rejects(store.saveScan('discovery', { cursor: 'lost' }, [
      { namespace: 'spec/project', repo: 'code/project', number: 2 },
      { namespace: 'spec/project', repo: 'code/project', number: 0 }
    ]), /check constraint/)
    assert.deepEqual(await store.scan('discovery'), { cursor: '2026-09-01', page: 2 })
    assert.equal((await store.due()).length, 1)

    let job = await ready(1)
    assert.deepEqual(await publish(job, 'source-1'), { stored: true, count: 1 })
    store = createFeedbackStore(pool)
    assert.equal(await store.analysisExists(job.id, 'run-1'), true)
    assert.equal((await publish(job, 'source-1')).stored, false)
    const [first] = await forJob(job)
    assert.equal((await forJob(job)).length, 1)
    assert.equal(first.payload.amendment, proposal('source-1').amendment)
    assert.equal(first.status, 'pending')
    await store.saveEvidence(job, { ...evidence('source-1'), sources: [{ id: 'comment:1', body: 'A conflicting payload under the same hash.' }] })
    let waiting = await store.queued()
    assert.ok(waiting.some(p => p.id === first.id))
    assert.equal(waiting.find(p => p.id === first.id).evidence.sources[0].body, 'Persist the deadline.')
    assert.equal(waiting.find(p => p.id === first.id).sourceRepo, 'code/project')

    assert.equal(await store.markPlaced([first.id], 'placed'), 1)
    assert.equal(await store.markPlaced([first.id], 'placed'), 0, 'placement is recorded once')
    await assert.rejects(store.markPlaced([first.id], 'accepted'), /placement status/)
    assert.ok(!(await store.queued()).some(p => p.id === first.id))
    assert.equal((await forJob(job))[0].status, 'placed')

    const changedJob = await store.saveEvidence(job, evidence('source-2'))
    await publish(changedJob, 'source-2', 'run-2', { proposals: [proposal('source-2', { amendment: 'Changed wording after placement.' })] })
    const [afterChange] = await forJob(job)
    assert.equal(afterChange.status, 'placed', 'a placed suggestion is not re-queued by a new analysis')
    assert.equal(afterChange.payload.amendment, proposal('source-1').amendment)

    const staleJob = await ready(4)
    const staleReader = { ...staleJob }
    await publish(staleJob, 'source-1')
    const nextJob = await store.saveEvidence(staleJob, evidence('source-new'))
    assert.equal(await store.saveEvidence(staleReader, evidence('source-1')), null)
    assert.equal((await publish(staleJob, 'source-1', 'obsolete-run')).stored, false)
    assert.equal(await store.analysisExists(staleJob.id, 'obsolete-run'), false)
    const beforeRollback = await forJob(staleJob)
    await assert.rejects(publish(nextJob, 'source-new', 'invalid-run', {
      proposals: [proposal('source-new', { targetNamespace: 'other/namespace' })]
    }), /namespace mismatch/)
    assert.equal(await store.analysisExists(staleJob.id, 'invalid-run'), false)
    assert.deepEqual(await forJob(staleJob), beforeRollback)
    await publish(nextJob, 'source-new', 'run-new')
    const [requeued] = await forJob(staleJob)
    assert.equal(requeued.status, 'pending')
    assert.equal(requeued.payload.sourceHash, 'source-new', 'a pending proposal follows its source')

    const racingJob = await ready(5)
    const generation = (await store.settings(racingJob.namespace)).generation
    assert.deepEqual(await store.toggle(racingJob.namespace, false, actor), { enabled: false, generation: generation + 1 })
    assert.ok(!(await store.due(100)).some(j => j.namespace === racingJob.namespace && !j.manual))
    const disabled = await publish(racingJob, 'source-1', 'paused-run', { settingsGeneration: generation })
    assert.equal(disabled.stored, false)
    await store.toggle(racingJob.namespace, true, actor)

    const lockedGeneration = (await store.settings(racingJob.namespace)).generation
    const holder = await pool.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT namespace FROM spec_board_feedback_settings WHERE namespace = $1 FOR UPDATE', [racingJob.namespace])
    const waitingPublication = store.recordAnalysis(racingJob, {
      runHash: 'locked-toggle-run', evidence: evidence('source-1'), proposals: [proposal('source-1')], settingsGeneration: lockedGeneration
    })
    await holder.query('UPDATE spec_board_feedback_settings SET enabled = false, generation = generation + 1 WHERE namespace = $1', [racingJob.namespace])
    await holder.query('COMMIT')
    holder.release()
    assert.equal((await waitingPublication).stored, false)
    await store.toggle(racingJob.namespace, true, actor)
    assert.equal((await publish(racingJob, 'source-1', 'paused-run', { settingsGeneration: generation })).stored, false)
    await store.toggle(racingJob.namespace, false, actor)
    await store.migrate()
    store = createFeedbackStore(pool)
    assert.equal((await store.settings(racingJob.namespace)).enabled, false)
    const manualJob = await ready(6, 'manual-source', true)
    assert.ok((await store.due(100)).some(j => j.id === manualJob.id))
    assert.equal((await publish(manualJob, 'manual-source')).stored, true)
    assert.equal((await pool.query('SELECT manual FROM spec_board_feedback_jobs WHERE id = $1', [manualJob.id])).rows[0].manual, false)
    const oldManual = await ready(60, 'unchanged-old-source', true)
    await store.finish(oldManual, '2020-01-01T00:00:00Z')
    const finished = await pool.query('SELECT manual, next_at FROM spec_board_feedback_jobs WHERE id = $1', [oldManual.id])
    assert.deepEqual(finished.rows[0], { manual: false, next_at: null })
    const reimported = await store.enqueue(oldManual.namespace, oldManual.repo, oldManual.number, true)
    await store.finish(oldManual, '2020-01-01T00:00:00Z')
    assert.ok((await store.due(100)).some(j => j.id === reimported.id && j.manual))
    await store.toggle(racingJob.namespace, true, actor)

    const emptyJob = await ready(7)
    assert.equal((await publish(emptyJob, 'source-1', 'empty-run', { proposals: [] })).stored, true)
    assert.equal(await store.analysisExists(emptyJob.id, 'empty-run'), true)
    assert.equal((await forJob(emptyJob)).length, 0)

    let unavailableJob = await ready(8)
    await publish(unavailableJob, 'source-1')
    const [unavailable] = await forJob(unavailableJob)
    await store.unavailable(unavailableJob, 'repository is private')
    assert.equal((await forJob(unavailableJob))[0].status, 'stale')
    assert.ok(!(await store.queued()).some(p => p.id === unavailable.id), 'a lost source parks its proposals')
    assert.equal((await publish(unavailableJob, 'source-1', 'old-request')).stored, false)
    unavailableJob = await ready(8)
    assert.equal(await store.analysisExists(unavailableJob.id, 'run-1'), false)
    assert.equal((await publish(unavailableJob, 'source-1')).stored, true)
    assert.ok((await store.queued()).some(p => p.id === unavailable.id), 'a source that comes back re-queues')

    const expiringJob = await ready(9)
    await publish(expiringJob, 'source-1')
    const [expiring] = await forJob(expiringJob)
    await store.markPlaced([expiring.id], 'commented')
    await pool.query("UPDATE spec_board_feedback_proposals SET decided_at = now() - interval '91 days' WHERE id = $1", [expiring.id])
    await pool.query("UPDATE spec_board_feedback_evidence SET created_at = now() - interval '91 days' WHERE job_id = $1", [expiringJob.id])
    await pool.query("UPDATE spec_board_feedback_runs SET created_at = now() - interval '91 days' WHERE job_id = $1", [expiringJob.id])
    assert.deepEqual(await store.cleanup(), { proposals: 1, evidence: 1 })
    const [tombstone] = await forJob(expiringJob)
    assert.equal(tombstone.payload, null)
    assert.equal(tombstone.status, 'commented')
    assert.equal((await pool.query('SELECT payload FROM spec_board_feedback_runs WHERE job_id = $1', [expiringJob.id])).rows[0].payload, null)
    assert.ok(!(await store.queued()).some(p => p.id === tombstone.id), 'a purged row never queues')

    const siblings = await ready(599)
    const pair = [proposal('source-1', { groupId: 'closed', amendment: 'Expired amendment text' }),
      proposal('source-1', { groupId: 'active', amendment: 'Active amendment text' })]
    await publish(siblings, 'source-1', 'siblings', { proposals: pair })
    const closed = (await forJob(siblings)).find(p => p.group_id === 'closed')
    await store.markPlaced([closed.id], 'placed')
    await pool.query("UPDATE spec_board_feedback_proposals SET decided_at=now() - interval '91 days' WHERE id=$1", [closed.id])
    await pool.query("UPDATE spec_board_feedback_runs SET payload=$1, created_at=now() - interval '91 days' WHERE job_id=$2", [JSON.stringify(pair), siblings.id])
    await store.cleanup()
    assert.equal((await forJob(siblings)).find(p => p.group_id === 'closed').payload, null)
    assert.equal((await forJob(siblings)).find(p => p.group_id === 'active').payload.amendment, 'Active amendment text')
    assert.equal((await pool.query('SELECT payload FROM spec_board_feedback_runs WHERE job_id=$1', [siblings.id])).rows[0].payload, null)
    assert.equal(await store.analysisExists(siblings.id, 'siblings'), true)

    const dormant = await store.enqueue('spec/waiting', 'code/waiting', 1)
    await store.waitForMerge(dormant)
    assert.deepEqual(await store.due(1, ['spec/waiting']), [])
    assert.deepEqual(await store.problems(['spec/waiting']), [])
    await store.saveScan('waiting', {}, [{ namespace: 'spec/waiting', repo: 'code/waiting', number: 1, updatedAt: new Date().toISOString() }])
    assert.equal((await store.due(1, ['spec/waiting']))[0].id, dormant.id, 'a provider update wakes a dormant unmerged PR')

    for (let number = 100; number < 210; number++) await store.enqueue('busy/namespace', 'busy/code', number)
    const fairJob = await store.enqueue('quiet/namespace', 'quiet/code', 1)
    assert.ok((await store.due(100)).some(j => j.id === fairJob.id))
    assert.equal((await store.due(1, ['quiet/namespace']))[0].id, fairJob.id)
    assert.equal((await store.due(1, ['quiet/namespace', 'busy/namespace']))[0].namespace, 'quiet/namespace')
    assert.equal((await store.due(1, ['busy/namespace', 'quiet/namespace']))[0].namespace, 'busy/namespace')
    assert.deepEqual(await store.due(100, []), [])

    await store.fail(racingJob, new Error('provider timeout'))
    assert.equal((await store.status()).failing, 1)
    assert.deepEqual((await store.problems(['spec/project'])).map(p => [p.repo, p.number, p.error]), [
      ['code/project', racingJob.number, 'provider timeout']
    ])
    assert.deepEqual(await store.problems(['other/namespace']), [])
    await store.defer(racingJob, 0)
    assert.ok((await store.due(100)).some(j => j.id === racingJob.id))
    console.log('feedback persistence tests passed')
  } finally {
    if (pool) await pool.end()
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
