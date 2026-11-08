const assert = require('assert/strict')
const crypto = require('crypto')
const { Pool } = require('pg')
const { createDocsFollowupStore } = require('./docs-followup-store')
const { createDocsFollowupService } = require('./docs-followup-service')

const connectionString = process.env.DOCS_TEST_DATABASE_URL
if (!connectionString) { console.error('Set DOCS_TEST_DATABASE_URL to an explicit PostgreSQL test database.'); process.exit(1) }
const source = number => ({ repo: 'team/app', number, mergeSha: 'a'.repeat(40), mergedAt: '2026-11-08T00:00:00Z',
  hash: 'c'.repeat(64), complete: true, files: [{ path: 'src/main.rs', content: 'Public behavior.', blob: 'd'.repeat(40) }] })
const baseline = { repo: 'team/docs', commit: 'b'.repeat(40), hash: 'e'.repeat(64), complete: true,
  files: [{ path: 'guide.md', content: 'Current guidance.', blob: 'f'.repeat(40), mode: '100644' }] }
const assessment = { needed: true, proposal: { summary: 'Document the changed behavior', reason: 'The existing guide describes the old behavior.',
  edits: [{ path: 'guide.md', beforeBlob: 'f'.repeat(40), content: 'Updated guidance.' }], evidence: [{ path: 'src/main.rs', quote: 'Public behavior.' }] } }

async function deliveryRecovery (pool, store) {
  const target = { namespace: 'flow/specs', targetRepo: 'flow/docs', paths: ['guide.md'], exclude: [], bot: 'docs-bot' }
  const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'fixture', namespaces: ['flow/specs'] }
  const remote = { branches: 0, commits: 0, prs: 0, comments: 0 }
  let crashed = false
  const service = createDocsFollowupService({ store, targets: [target], roles: async () => ({ 'implementation-repos': ['flow/app'] }),
    getBots: async () => [bot], createProvider: () => ({
      async discover () { return { cursor: { scanned: true }, items: [{ number: 42 }], complete: true } },
      async inspect () { return { ...source(42), repo: 'flow/app', mergedAt: new Date(Date.now() + 1000).toISOString() } },
      async target () { return { ...baseline, repo: 'flow/docs' } },
      async preflight () {},
      async advance (intent, { assertActive }) {
        await assertActive()
        assert.equal(intent.source.number, 42)
        assert.equal(intent.proposal.edits[0].path, 'guide.md')
        if (intent.stage === 'prepared') {
          remote.branches++
          return { stage: 'branch', branch: 'docs/' + intent.key }
        }
        if (intent.stage === 'branch') {
          remote.commits++
          return { stage: 'commit', commit: '1'.repeat(40) }
        }
        if (intent.stage === 'commit') {
          if (!remote.prs) remote.prs++
          if (!crashed) { crashed = true; throw Object.assign(new Error('Response lost after PR creation'), { code: 'provider' }) }
          return { stage: 'pr', prNumber: 7, prUrl: 'https://github.com/flow/docs/pull/7' }
        }
        if (intent.stage === 'pr') {
          remote.comments++
          return { stage: 'comment', commentId: '81' }
        }
        return { stage: 'complete' }
      }
    }), assess: async () => assessment })
  for (let tick = 0; tick < 24; tick++) {
    await service.tick()
    await pool.query("UPDATE spec_board_docs_jobs SET next_at=now() WHERE namespace='flow/specs'")
    const { rows: [job] } = await pool.query("SELECT phase FROM spec_board_docs_jobs WHERE namespace='flow/specs'")
    if (job?.phase === 'complete') break
  }
  assert.deepEqual(remote, { branches: 1, commits: 1, prs: 1, comments: 1 }, 'an ambiguous PR response resumes the same durable intent')
  const row = (await pool.query("SELECT * FROM spec_board_docs_jobs WHERE namespace='flow/specs'")).rows[0]
  assert.equal(row.phase, 'complete')
  const resumed = await createDocsFollowupStore(pool).intent({ id: String(row.id) })
  assert.equal(resumed.stage, 'complete')
  assert.equal(resumed.prNumber, 7)
  assert.equal(resumed.commentId, '81')
  await service.tick(); await service.tick(); await service.tick()
  assert.equal(remote.prs, 1, 'later discovery cannot recreate an already delivered follow-up')
}

async function removedScope (pool, store) {
  const config = { namespace: 'off/specs', targetRepo: 'off/docs', repos: ['off/removed', 'off/kept'], configHash: '7'.repeat(64) }
  const scopes = await store.syncSources(config)
  const removed = scopes.find(scope => scope.sourceRepo === 'off/removed')
  const kept = scopes.find(scope => scope.sourceRepo === 'off/kept')
  const claim = sourceRepo => ({ namespace: config.namespace, targetRepo: config.targetRepo, sourceRepos: [sourceRepo] })
  await store.enqueue(removed, 101)
  let job = await store.claim(claim(removed.sourceRepo))
  await store.saveInputs(job, { source: { ...source(101), repo: removed.sourceRepo },
    baseline: { ...baseline, repo: config.targetRepo }, botFingerprint: '8'.repeat(64) })
  await store.assessed(await store.claim(claim(removed.sourceRepo)), assessment)
  job = await store.claim(claim(removed.sourceRepo))
  await store.saveStep(job, { stage: 'pr', branch: 'docs/existing', commit: '9'.repeat(40),
    prNumber: 12, prUrl: 'https://github.com/off/docs/pull/12' })
  const stale = await store.claim(claim(removed.sourceRepo))
  await store.enqueue(kept, 102)
  await store.syncSources({ ...config, repos: [kept.sourceRepo] })
  const stopped = (await pool.query('SELECT phase,reason,lease_token FROM spec_board_docs_jobs WHERE id=$1', [stale.id])).rows[0]
  assert.deepEqual(stopped, { phase: 'stopped', reason: 'docs-scope-changed', lease_token: null })
  await assert.rejects(store.assertLease(stale), { code: 'docs-lease-lost' })
  await assert.rejects(store.saveStep(stale, { stage: 'complete' }), { code: 'docs-lease-lost' })
  const receipt = await store.intent(stale)
  assert.equal(receipt.stage, 'stopped')
  assert.equal(receipt.prNumber, 12)
  assert.equal(receipt.commit, '9'.repeat(40), 'deactivation keeps the remote publication receipt')
  const active = await store.claim(claim(kept.sourceRepo))
  assert.equal(active.phase, 'inspect', 'removing one source leaves its sibling available')
  await store.reconcileTargets([{ namespace: config.namespace, targetRepo: config.targetRepo }])
  await store.assertLease(active)
  await store.reconcileTargets([])
  await assert.rejects(store.assertLease(active), { code: 'docs-lease-lost' })
  assert.equal((await pool.query('SELECT phase FROM spec_board_docs_jobs WHERE id=$1', [active.id])).rows[0].phase, 'stopped')
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_docs_sources WHERE enabled')).rows[0].n, 0)
  await pool.query("UPDATE spec_board_docs_jobs SET updated_at=now()-interval '91 days' WHERE namespace=$1", [config.namespace])
  await store.cleanup()
  const redacted = await store.intent(stale)
  assert.deepEqual(redacted.source, {})
  assert.deepEqual(redacted.proposal, {})
  assert.equal(redacted.prNumber, 12, 'retention removes stopped evidence without losing delivery identity')
  const [resumed] = await store.syncSources({ ...config, repos: [kept.sourceRepo] })
  await store.enqueue(resumed, 103)
  const beforeDisable = await store.claim(claim(kept.sourceRepo))
  const disabled = createDocsFollowupService({ store,
    targets: [{ ...config, paths: ['guide.md'], exclude: [], bot: 'disabled-bot' }],
    roles: async () => ({ 'implementation-repos': ['off/new'] }), getBots: async () => [],
    createProvider: () => { throw new Error('Unavailable bot must not create a provider') }, assess: async () => assessment })
  await disabled.tick()
  await assert.rejects(store.assertLease(beforeDisable), { code: 'docs-lease-lost' })
  assert.equal((await pool.query('SELECT phase FROM spec_board_docs_jobs WHERE id=$1', [beforeDisable.id])).rows[0].phase, 'stopped')
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM spec_board_docs_sources WHERE source_repo='off/new'")).rows[0].n, 0,
    'removal does not activate replacement sources while the bot is unavailable')
}

async function retryEvidence (pool, store) {
  const config = { namespace: 'retry/specs', targetRepo: 'retry/docs', repos: ['retry/app'], configHash: 'a'.repeat(64) }
  const [scope] = await store.syncSources(config)
  const claim = { namespace: config.namespace, targetRepo: config.targetRepo, sourceRepos: config.repos }
  await store.enqueue(scope, 201)
  const original = await store.claim(claim)
  await store.defer(original, { code: 'docs-evidence-limit', retryAt: Date.now() + 86400000 })
  assert.equal(await store.claim(claim), undefined)
  await store.enqueue(scope, 201)
  const retry = await store.claim(claim)
  assert.equal(retry?.id, original.id, 'explicit backfill retries the existing pre-publication job without waiting a day')
  assert.equal(retry.phase, 'inspect')
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_docs_jobs WHERE namespace=$1', [config.namespace])).rows[0].n, 1)
}

async function assessmentRecovery (pool, store) {
  const config = { namespace: 'attempt/specs', targetRepo: 'attempt/docs', repos: ['attempt/app'], configHash: 'b'.repeat(64) }
  const [scope] = await store.syncSources(config)
  const claim = { namespace: config.namespace, targetRepo: config.targetRepo, sourceRepos: config.repos,
    leaseMs: 120000, assessmentLeaseMs: 240000 }
  const inputs = number => ({ source: { ...source(number), repo: config.repos[0] },
    baseline: { ...baseline, repo: config.targetRepo }, botFingerprint: 'c'.repeat(64) })
  await store.enqueue(scope, 301)
  const original = await store.claim(claim)
  await store.saveInputs(original, inputs(301))
  let job = await store.claim(claim)
  assert.ok((await pool.query('SELECT extract(epoch FROM lease_until-now()) AS remaining FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0].remaining > 230,
    'the assessment lease allows the full model timeout and API margin')
  assert.equal(await store.beginAssessment(job), 1)
  const reserved = (await pool.query('SELECT model_attempts,model_attempt_lease FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0]
  assert.deepEqual(reserved, { model_attempts: 1, model_attempt_lease: job.token })
  await assert.rejects(store.beginAssessment(job), { code: 'docs-lease-lost' }, 'the same lease cannot dispatch twice')
  assert.equal(await store.refundBudgetAttempt(job), 0)
  await assert.rejects(store.refundBudgetAttempt(job), { code: 'docs-lease-lost' }, 'budget refunds cannot be replayed')
  await store.defer(job, { code: 'budget' })
  await pool.query('UPDATE spec_board_docs_jobs SET next_at=now() WHERE id=$1', [job.id])
  job = await store.claim(claim)
  assert.equal(await store.beginAssessment(job), 1)
  await pool.query("UPDATE spec_board_docs_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id])
  job = await createDocsFollowupStore(pool).claim(claim)
  assert.equal(job.modelAttempts, 1, 'a process restart retains an uncertain dispatched attempt')
  assert.equal(await store.beginAssessment(job), 2)
  await store.replan(job, config.configHash)
  job = await store.claim(claim)
  assert.equal(job.modelAttempts, 2, 'automatic replanning retains spent attempts')
  await store.saveInputs(job, inputs(301))
  job = await store.claim(claim)
  assert.equal(await store.beginAssessment(job), 3)
  await store.cleanup()
  assert.equal((await pool.query('SELECT phase FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0].phase, 'assess',
    'cleanup does not stop the final model request while its lease is active')
  await pool.query("UPDATE spec_board_docs_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id])
  await store.cleanup()
  assert.deepEqual((await pool.query('SELECT phase,reason FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0],
    { phase: 'stopped', reason: 'docs-assessment-failed' })
  assert.equal(await store.claim(claim), undefined, 'an exhausted crashed assessment cannot issue a fourth request')
  await store.enqueue(scope, 301)
  job = await store.claim(claim)
  assert.equal(job.id, original.id)
  assert.equal(job.modelAttempts, 0, 'explicit backfill starts a new finite attempt allowance')
  await store.stop(job, 'manual-decision')

  await store.enqueue(scope, 302)
  job = await store.claim(claim)
  await store.saveInputs(job, inputs(302))
  await store.assessed(await store.claim(claim), assessment)
  job = await store.claim(claim)
  await store.saveStep(job, { stage: 'pr', branch: 'docs/expiry', commit: 'd'.repeat(40), prNumber: 302,
    prUrl: 'https://github.com/attempt/docs/pull/302' })
  job = await store.claim(claim)
  await pool.query("UPDATE spec_board_docs_jobs SET expires_at=now()-interval '1 second' WHERE id=$1", [job.id])
  await store.cleanup()
  assert.equal((await pool.query('SELECT phase FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0].phase, 'publish')
  await pool.query("UPDATE spec_board_docs_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id])
  await store.cleanup()
  const expired = (await pool.query('SELECT phase,reason,source FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0]
  assert.equal(expired.phase, 'stopped')
  assert.equal(expired.reason, 'docs-expired')
  assert.equal(expired.source.number, 302)
  assert.equal((await store.intent(job)).stage, 'stopped')
  assert.equal((await store.intent(job)).prNumber, 302)
  await pool.query("UPDATE spec_board_docs_jobs SET updated_at=now()-interval '91 days' WHERE id=$1", [job.id])
  await store.cleanup()
  assert.deepEqual((await store.intent(job)).proposal, {})
  assert.equal((await store.intent(job)).prNumber, 302, 'expiry and retention preserve publication receipts')
  await store.enqueue(scope, 302)
  assert.equal(await store.claim(claim), undefined, 'backfill cannot recreate an expired published proposal')

  await store.enqueue(scope, 303)
  job = await store.claim(claim)
  await store.saveInputs(job, inputs(303))
  await store.assessed(await store.claim(claim), assessment)
  job = await store.claim(claim)
  await store.saveStep(job, { stage: 'pr', branch: 'docs/redacted', prNumber: 303,
    prUrl: 'https://github.com/attempt/docs/pull/303' })
  job = await store.claim(claim)
  await store.stop(job, 'SENSITIVE_CONTENT', { redact: true })
  const scrubbed = (await pool.query('SELECT phase,reason,source,baseline,redacted_at FROM spec_board_docs_jobs WHERE id=$1', [job.id])).rows[0]
  assert.equal(scrubbed.phase, 'stopped')
  assert.equal(scrubbed.reason, 'SENSITIVE_CONTENT')
  assert.equal(scrubbed.source, null)
  assert.equal(scrubbed.baseline, null)
  assert.ok(scrubbed.redacted_at)
  const receipt = await store.intent(job)
  assert.deepEqual([receipt.source, receipt.baseline, receipt.proposal], [{}, {}, {}])
  assert.equal(receipt.prNumber, 303, 'immediate sensitive-content redaction keeps delivery identity')
}

async function main () {
  const schema = 'docs_test_' + crypto.randomBytes(12).toString('hex')
  const admin = new Pool({ connectionString, max: 1 })
  let pool
  try {
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
    const store = createDocsFollowupStore(pool)
    await store.migrate(); await store.migrate()
    const config = { namespace: 'team/specs', targetRepo: 'team/docs', repos: ['team/app'], configHash: '1'.repeat(64) }
    let [scope] = await store.syncSources(config)
    const firstActivation = scope.activatedAt.toISOString()
    assert.equal((await store.syncSources(config))[0].activatedAt.toISOString(), firstActivation)
    await assert.rejects(store.saveScan(scope, { cursor: { page: 2 }, items: [{ number: 1 }, { number: -1 }] }))
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_docs_jobs')).rows[0].n, 0)
    assert.equal((await store.syncSources(config))[0].cursor, null, 'failed enqueue cannot advance its discovery cursor')
    await store.saveScan(scope, { cursor: { page: 2 }, items: [{ number: 1 }, { number: 2 }] })
    assert.deepEqual((await createDocsFollowupStore(pool).syncSources(config))[0].cursor, { page: 2 })
    const claimInput = { namespace: 'team/specs', targetRepo: 'team/docs', sourceRepos: ['team/app'] }
    const claims = await Promise.all([store.claim(claimInput), store.claim(claimInput)])
    assert.equal(new Set(claims.map(job => job.id)).size, 2)
    assert.equal(await store.claim(claimInput), undefined, 'another worker cannot claim active leases')
    const old = claims[0]
    await pool.query('UPDATE spec_board_docs_jobs SET lease_until=now()-interval \'1 second\' WHERE id=$1', [old.id])
    const replacement = await store.claim(claimInput)
    assert.equal(replacement.id, old.id)
    assert.notEqual(replacement.token, old.token)
    await assert.rejects(store.saveInputs(old, { source: source(old.number), baseline, botFingerprint: '2'.repeat(64) }), { code: 'docs-lease-lost' })
    await store.saveInputs(replacement, { source: source(replacement.number), baseline, botFingerprint: '2'.repeat(64) })
    let analyzed = await store.claim(claimInput)
    assert.equal(analyzed.phase, 'assess')
    await store.replan(analyzed, '3'.repeat(64))
    const replanned = await store.claim(claimInput)
    assert.equal(replanned.phase, 'inspect')
    assert.equal(replanned.configHash, '3'.repeat(64))
    assert.equal(replanned.source, null)
    await store.saveInputs(replanned, { source: source(replanned.number), baseline, botFingerprint: '4'.repeat(64) })
    analyzed = await store.claim(claimInput)
    await store.assessed(analyzed, { needed: false, reason: 'The public behavior is already documented.' })
    assert.equal((await store.status()).unchanged, 1)
    const pending = claims[1]
    await store.saveInputs(pending, { source: source(pending.number), baseline, botFingerprint: '2'.repeat(64) })
    await store.assessed(await store.claim(claimInput), assessment)
    let publishing = await store.claim(claimInput)
    const intent = await store.intent(publishing)
    assert.equal(intent.stage, 'prepared')
    assert.equal(intent.source.mergeSha, source(2).mergeSha)
    assert.equal(intent.proposal.edits[0].beforeBlob, baseline.files[0].blob)
    await assert.rejects(store.replan(publishing, '4'.repeat(64)), { code: 'docs-lease-lost' }, 'a prepared intent is not rewritten after an ambiguous external action')
    await store.saveStep(publishing, { stage: 'branch', branch: 'docs/' + intent.key })
    publishing = await store.claim(claimInput)
    await store.saveStep(publishing, { stage: 'stopped', reason: 'maintainer-edited' })
    await store.enqueue(scope, pending.number)
    assert.equal(await store.claim(claimInput), undefined, 'manual backfill cannot restart work that reached publication')
    await store.saveScan(scope, { cursor: { page: 3 }, items: [{ number: pending.number }] })
    assert.equal(await store.claim(claimInput), undefined, 'discovery does not undo a maintainer decision')
    assert.equal((await store.status()).stopped, 1)
    const other = { ...config, namespace: 'other/specs' }
    const [otherScope] = await store.syncSources(other)
    await store.enqueue(otherScope, pending.number)
    const otherClaim = { ...claimInput, namespace: 'other/specs' }
    let duplicate = await store.claim(otherClaim)
    assert.equal(duplicate.manual, true)
    await store.saveInputs(duplicate, { source: source(pending.number), baseline, botFingerprint: '2'.repeat(64) })
    duplicate = await store.claim(otherClaim)
    await store.assessed(duplicate, assessment)
    assert.equal(await store.claim(otherClaim), undefined)
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM spec_board_docs_intents')).rows[0].n, 1,
      'overlapping namespace mappings cannot create a second intent for the same merged PR and target')
    await pool.query("UPDATE spec_board_docs_sources SET activated_at='2001-01-01' WHERE namespace='team/specs'")
    await store.syncSources({ ...config, repos: [] })
    ;[scope] = await store.syncSources(config)
    assert.ok(scope.activatedAt.getUTCFullYear() > 2001, 'reactivated sources start a fresh automatic discovery window')
    assert.equal(scope.cursor, null)
    await assert.rejects(store.saveScan({ ...scope, generation: scope.generation - 1 }, { cursor: {}, items: [] }), { code: 'docs-lease-lost' })
    await store.enqueue(scope, 91)
    const retry = await store.claim(claimInput)
    await store.saveInputs(retry, { source: source(91), baseline, botFingerprint: '5'.repeat(64) })
    await store.replan(await store.claim(claimInput), scope.configHash, true)
    const delayed = (await pool.query('SELECT phase,source,baseline,attempts,next_at>now() AS delayed FROM spec_board_docs_jobs WHERE id=$1', [retry.id])).rows[0]
    assert.deepEqual(delayed, { phase: 'inspect', source: null, baseline: null, attempts: 1, delayed: true })
    assert.equal(await store.claim(claimInput), undefined, 'moving documentation does not create a tight retry loop')
    await pool.query('UPDATE spec_board_docs_jobs SET next_at=now() WHERE id=$1', [retry.id])
    await store.stop(await store.claim(claimInput), 'docs-source-changed')
    await store.enqueue(scope, 91)
    const reopened = await store.claim(claimInput)
    assert.equal(reopened.id, retry.id)
    assert.equal(reopened.phase, 'inspect')
    assert.equal(reopened.source, null)
    assert.equal(reopened.manual, true, 'explicit backfill can reassess a stopped job before any publication intent')
    await store.stop(reopened, 'manual-decision')
    await store.enqueue(scope, 91)
    assert.equal(await store.claim(claimInput), undefined, 'unrecognized terminal decisions stay terminal')
    await deliveryRecovery(pool, store)
    ;[scope] = await store.syncSources(config)
    const receipts = (await pool.query('SELECT operation_key,branch,pr_number,pr_url,comment_id FROM spec_board_docs_intents ORDER BY id')).rows
    await store.enqueue(scope, 93)
    const retained = await store.claim(claimInput)
    await store.saveInputs(retained, { source: source(93), baseline, botFingerprint: '5'.repeat(64) })
    await pool.query("UPDATE spec_board_docs_jobs SET updated_at=now()-interval '91 days'")
    assert.ok(await store.cleanup() > 0)
    assert.equal(await store.cleanup(), 0)
    assert.deepEqual((await pool.query('SELECT operation_key,branch,pr_number,pr_url,comment_id FROM spec_board_docs_intents ORDER BY id')).rows, receipts)
    assert.ok((await pool.query('SELECT source,baseline,proposal FROM spec_board_docs_intents')).rows.every(row =>
      Object.keys(row.source).length === 0 && Object.keys(row.baseline).length === 0 && Object.keys(row.proposal).length === 0))
    assert.equal((await pool.query('SELECT source FROM spec_board_docs_jobs WHERE id=$1', [retained.id])).rows[0].source.number, 93,
      'terminal retention does not erase pending evidence')
    const [flowScope] = await store.syncSources({ namespace: 'flow/specs', targetRepo: 'flow/docs', repos: ['flow/app'], configHash: '6'.repeat(64) })
    await store.saveScan(flowScope, { cursor: {}, items: [{ number: 42 }] })
    assert.equal((await pool.query("SELECT phase FROM spec_board_docs_jobs WHERE namespace='flow/specs'")).rows[0].phase, 'complete',
      'redacted evidence retains the deduplication receipt')
    await removedScope(pool, store)
    await retryEvidence(pool, store)
    await assessmentRecovery(pool, store)
    console.log('documentation follow-up database tests passed')
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
