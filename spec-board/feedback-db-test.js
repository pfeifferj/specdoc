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
    const forJob = async job => (await store.list([job.namespace], 500)).filter(p => p.job.id === job.id)

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
    let [first] = await forJob(job)
    assert.equal((await forJob(job)).length, 1)
    assert.equal(first.evidence.hash, 'source-1')
    await store.saveEvidence(job, { ...evidence('source-1'), sources: [{ id: 'comment:1', body: 'A conflicting payload under the same hash.' }] })
    assert.equal((await store.get(first.id)).evidence.sources[0].body, 'Persist the deadline.')
    assert.equal(first.amendment, proposal('source-1').amendment)
    assert.equal(first.status, 'pending')

    const contenders = await Promise.all([
      store.decide(first.id, first.version, 'accept', actor),
      store.decide(first.id, first.version, 'dismiss', { login: 'reviewer' })
    ])
    assert.equal(contenders.filter(Boolean).length, 1)
    first = await store.get(first.id)
    assert.equal(first.audit.length, 1)
    assert.ok(['accepted', 'dismissed'].includes(first.status))
    assert.equal(await store.decide(first.id, first.version - 1, 'dismiss', actor), null)

    const stickyJob = await ready(3)
    await publish(stickyJob, 'source-1')
    let [sticky] = await forJob(stickyJob)
    sticky = await store.decide(sticky.id, sticky.version, 'dismiss', actor)
    const changedStickyJob = await store.saveEvidence(stickyJob, evidence('source-2'))
    await publish(changedStickyJob, 'source-2', 'run-2', {
      proposals: [proposal('source-2', { amendment: 'Changed wording must not override dismissal.' })]
    })
    let retained = await store.get(sticky.id)
    assert.equal(retained.status, 'dismissed')
    assert.equal(retained.stale, true)
    assert.equal(retained.sourceHash, 'source-1')
    assert.equal(retained.amendment, proposal('source-1').amendment)
    assert.equal(retained.audit.length, 1)
    assert.equal((await forJob(stickyJob)).length, 1)

    retained = await store.decide(retained.id, retained.version, 'reconsider', actor)
    assert.equal(retained.status, 'stale')
    assert.equal(retained.job.manual, true)
    assert.equal(await store.analysisExists(stickyJob.id, 'run-2'), false)
    await publish(retained.job, 'source-2', 'run-2')
    retained = await store.get(sticky.id)
    assert.equal(retained.status, 'pending')
    assert.equal(retained.sourceHash, 'source-2')
    assert.deepEqual(retained.audit.map(d => d.action), ['dismiss', 'reconsider'])

    const staleJob = await ready(4)
    const staleReader = { ...staleJob }
    await publish(staleJob, 'source-1')
    const [stale] = await forJob(staleJob)
    const nextJob = await store.saveEvidence(staleJob, evidence('source-new'))
    assert.equal(await store.saveEvidence(staleReader, evidence('source-1')), null)
    assert.equal(await store.decide(stale.id, stale.version, 'accept', actor), null)
    assert.equal((await publish(staleJob, 'source-1', 'obsolete-run')).stored, false)
    assert.equal(await store.analysisExists(staleJob.id, 'obsolete-run'), false)
    const beforeRollback = await store.get(stale.id)
    await assert.rejects(publish(nextJob, 'source-new', 'invalid-run', {
      proposals: [proposal('source-new', { targetNamespace: 'other/namespace' })]
    }), /namespace mismatch/)
    assert.equal(await store.analysisExists(staleJob.id, 'invalid-run'), false)
    assert.deepEqual(await store.get(stale.id), beforeRollback)

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
    assert.equal((await forJob(manualJob))[0].job.manual, false)
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
    const hidden = await store.get(unavailable.id)
    assert.equal(hidden.job.available, false)
    assert.equal(hidden.status, 'stale')
    assert.equal(await store.decide(hidden.id, hidden.version, 'accept', actor), null)
    assert.equal((await publish(unavailableJob, 'source-1', 'old-request')).stored, false)
    unavailableJob = await ready(8)
    assert.equal(await store.analysisExists(unavailableJob.id, 'run-1'), false)
    assert.equal((await publish(unavailableJob, 'source-1')).stored, true)
    const refreshed = await store.get(unavailable.id)
    assert.equal((await store.decide(refreshed.id, refreshed.version, 'reconsider', actor)).status, 'stale')

    const incorporatedJob = await ready(9)
    await publish(incorporatedJob, 'source-1')
    let [incorporated] = await forJob(incorporatedJob)
    incorporated = await store.decide(incorporated.id, incorporated.version, 'accept', actor)
    assert.equal(await store.decide(incorporated.id, incorporated.version, 'incorporate', actor), null)
    incorporated = await store.decide(incorporated.id, incorporated.version, 'incorporate', actor, {
      pr: 20, url: 'https://github.com/spec/project/pull/20'
    })
    assert.equal(incorporated.status, 'incorporated')
    assert.deepEqual(incorporated.audit.map(d => d.action), ['accept', 'incorporate'])
    await pool.query("UPDATE spec_board_feedback_proposals SET decided_at = now() - interval '91 days' WHERE id = $1", [incorporated.id])
    await pool.query("UPDATE spec_board_feedback_evidence SET created_at = now() - interval '91 days' WHERE job_id = $1", [incorporatedJob.id])
    await pool.query("UPDATE spec_board_feedback_runs SET created_at = now() - interval '91 days' WHERE job_id = $1", [incorporatedJob.id])
    assert.deepEqual(await store.cleanup(), { proposals: 1, evidence: 1 })
    const tombstone = await store.get(incorporated.id)
    assert.equal(tombstone.purged, true)
    assert.equal(tombstone.amendment, undefined)
    assert.equal(tombstone.evidence, null)
    assert.equal(tombstone.status, 'incorporated')
    assert.equal(tombstone.audit.length, 2)
    assert.equal((await pool.query('SELECT payload FROM spec_board_feedback_runs WHERE job_id = $1', [incorporatedJob.id])).rows[0].payload, null)
    assert.equal((await publish(incorporatedJob, 'source-1', 'new-model')).stored, true)
    assert.equal((await store.get(incorporated.id)).purged, true)
    const latestTombstone = await store.get(tombstone.id)
    const reconsideredTombstone = await store.decide(tombstone.id, latestTombstone.version, 'reconsider', actor)
    const restoredJob = await store.saveEvidence(reconsideredTombstone.job, evidence('source-1'))
    assert.equal((await publish(restoredJob, 'source-1', 'restored-run')).stored, true)
    const restored = await store.get(tombstone.id)
    assert.equal(restored.purged, false)
    assert.equal(restored.evidence.sources[0].body, 'Persist the deadline.')
    assert.deepEqual(restored.audit.map(d => d.action), ['accept', 'incorporate', 'reconsider'])

    const pagedJob = await ready(600)
    await publish(pagedJob, 'source-1', 'paged', { proposals: [proposal('source-1', { targetNote: 'page-owner' })] })
    const [owned] = await forJob(pagedJob)
    await pool.query(`INSERT INTO spec_board_feedback_proposals
      (job_id, target_note, target_namespace, group_id, source_hash, payload)
      SELECT $1, 'page-others', 'spec/project', 'page-' || n, 'source-1', $2::jsonb
      FROM generate_series(1, 105) n`, [pagedJob.id, JSON.stringify(proposal('source-1'))])
    const onlyOwned = await store.list(['spec/project'], 100, { targetNotes: ['page-owner'] })
    assert.deepEqual(onlyOwned.map(p => p.id), [owned.id], 'authorization scope is applied before the page limit')
    const pageOne = await store.list(['spec/project'], 100, { targetNotes: ['page-owner', 'page-others'] })
    const pageTwo = await store.list(['spec/project'], 100, { targetNotes: ['page-owner', 'page-others'], before: pageOne.at(-1).id })
    assert.equal(pageOne.length, 100)
    assert.equal(pageTwo.length, 6)
    assert.equal(pageTwo.at(-1).id, owned.id)
    assert.equal(new Set([...pageOne, ...pageTwo].map(p => p.id)).size, 106)
    assert.deepEqual(await store.list(['spec/project'], 100, { targetNotes: [] }), [])

    const waiting = await store.enqueue('spec/waiting', 'code/waiting', 1)
    await store.waitForMerge(waiting)
    assert.deepEqual(await store.due(1, ['spec/waiting']), [])
    assert.deepEqual(await store.problems(['spec/waiting']), [])
    await store.saveScan('waiting', {}, [{ namespace: 'spec/waiting', repo: 'code/waiting', number: 1, updatedAt: new Date().toISOString() }])
    assert.equal((await store.due(1, ['spec/waiting']))[0].id, waiting.id, 'a provider update wakes a dormant unmerged PR')

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
    assert.deepEqual(await store.list(['unrelated/namespace']), [])
    console.log('feedback persistence tests passed')
  } finally {
    if (pool) await pool.end()
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
