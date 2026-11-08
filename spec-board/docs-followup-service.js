const crypto = require('crypto')
const { modelOptions } = require('./model-output')

const repoName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const fail = code => Object.assign(new Error('Documentation follow-up could not continue.'), { code })
const terminal = new Set(['docs-scope-changed', 'docs-before-activation', 'docs-source-changed', 'docs-source-branch', 'docs-target-changed',
  'docs-generated-source', 'docs-proposal-changed', 'docs-proposal-removed', 'docs-branch-changed', 'docs-branch-removed',
  'docs-branch-collision', 'docs-comment-changed', 'docs-comment-removed'])
const staticEvidence = new Set(['docs-evidence-limit', 'docs-evidence-unsupported', 'docs-evidence-mismatch'])
const expectedWait = new Set(['budget', 'incomplete', 'docs-lease-lost', 'docs-model-changed', ...staticEvidence])
const botFingerprint = bot => fingerprint({ name: bot.name, url: bot.url, model: bot.model, prompt: bot.prompt,
  api_key: bot.api_key, ...modelOptions(bot),
  namespaces: [...(bot.namespaces || [])].sort() })

function createDocsFollowupService ({ store, targets = [], roles, getBots, createProvider, assess,
  modelCall, healthState, progress = () => {}, stepMs = 60000, assessmentMs = 180000 }) {
  if (!store || typeof roles !== 'function' || typeof getBots !== 'function' || typeof createProvider !== 'function' || typeof assess !== 'function') {
    throw new Error('Documentation storage, scope, model and GitHub dependencies are required')
  }
  if (!Number.isSafeInteger(stepMs) || stepMs < 1000 || stepMs > 60000) throw new Error('Invalid documentation step deadline')
  if (!Number.isSafeInteger(assessmentMs) || assessmentMs < stepMs || assessmentMs > 300000) throw new Error('Invalid documentation assessment deadline')
  let turn = 0
  let running = false
  const positions = new Map()
  let health = { pending: 0, deferred: 0, unchanged: 0, completed: 0, stopped: 0 }

  async function configuration (target, signal) {
    signal?.throwIfAborted()
    if (!target || !targets.includes(target) || !repoName(target.namespace) || !repoName(target.targetRepo) ||
        !Array.isArray(target.paths) || !target.paths.length || !Array.isArray(target.exclude || [])) throw fail('docs-scope-unavailable')
    const policy = await roles(target.namespace, true, { signal })
    const declared = policy?.['implementation-repos']
    const raw = Array.isArray(declared) ? declared : typeof declared === 'string' ? declared.split(',') : null
    if (!raw || raw.length > 100 || raw.some(item => typeof item !== 'string' || !repoName(item.trim()))) throw fail('docs-scope-unavailable')
    const repos = [...new Set(raw.map(item => item.trim().toLowerCase()))].sort()
    await store.retireSources({ namespace: target.namespace, targetRepo: target.targetRepo, repos })
    const bots = await getBots()
    const bot = bots.find(item => item.name === target.bot && item.enabled !== false && item.namespaces?.includes(target.namespace))
    if (!bot) throw fail('docs-bot-unavailable')
    const botHash = botFingerprint(bot)
    const configHash = fingerprint({ namespace: target.namespace, targetRepo: target.targetRepo, bot: target.bot })
    return { config: target, bot, botHash, configHash, repos }
  }

  async function processJob (job, target, config, api, signal, callModel) {
    const intent = job.phase === 'publish' ? await store.intent(job) : null
    const assertActive = async () => {
      signal.throwIfAborted()
      await store.assertLease(job)
      const current = await configuration(target, signal)
      if (!current.repos.includes(job.sourceRepo)) throw fail('docs-scope-changed')
      if (current.configHash !== job.configHash) throw Object.assign(fail('docs-scope-changed'), { replanHash: current.configHash })
      const allowed = current.config.paths.filter(path => !(current.config.exclude || []).includes(path)).sort()
      if (job.phase === 'assess' && JSON.stringify((job.baseline?.files || []).map(file => file.path).sort()) !== JSON.stringify(allowed)) {
        throw Object.assign(fail('docs-scope-changed'), { replanHash: current.configHash })
      }
      if (job.phase === 'publish' && (!intent || !Array.isArray(intent.proposal?.edits) ||
          !intent.proposal.edits.length || intent.proposal.edits.some(edit => !allowed.includes(edit.path)))) throw fail('docs-scope-changed')
      if (job.phase !== 'publish' && current.botHash !== (job.phase === 'assess' ? job.botFingerprint : config.botHash)) {
        throw Object.assign(fail('docs-model-changed'), { replanHash: current.configHash })
      }
      if (!job.manual && job.source?.mergedAt && Date.parse(job.source.mergedAt) < Date.parse(job.activatedAt)) throw fail('docs-before-activation')
      await store.assertLease(job)
      signal.throwIfAborted()
      return current
    }
    await assertActive()
    if (job.phase === 'inspect') {
      const source = await api.inspect(job.sourceRepo, job.number, { signal, activatedAt: job.activatedAt, manual: job.manual })
      progress()
      if (!source || source.complete !== true || source.repo?.toLowerCase() !== job.sourceRepo || source.number !== job.number ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.mergeSha || '') || !Number.isFinite(Date.parse(source.mergedAt))) throw fail('incomplete')
      if (!job.manual && Date.parse(source.mergedAt) < Date.parse(job.activatedAt)) {
        await store.stop(job, 'before-activation')
        return
      }
      const baseline = await api.target(target, { signal })
      progress()
      if (!baseline || baseline.complete !== true || baseline.repo?.toLowerCase() !== target.targetRepo.toLowerCase() || !baseline.files?.length) throw fail('incomplete')
      await assertActive()
      await store.saveInputs(job, { source, baseline, botFingerprint: config.botHash })
    } else if (job.phase === 'assess') {
      if (job.modelAttempts >= 3) throw fail('docs-assessment-failed')
      if (!job.source || !job.baseline) throw fail('incomplete')
      await api.preflight({ source: job.source, baseline: job.baseline, config: target, expectedBot: job.botFingerprint, signal })
      let dispatched = false
      const attemptModel = async (...args) => {
        if (dispatched) throw fail('docs-model-invalid')
        await assertActive()
        job.modelAttempts = await store.beginAssessment(job)
        dispatched = true
        job.modelAttempted = true
        try { return await callModel(...args) } catch (error) {
          if (error.code === 'budget') {
            job.modelAttempts = await store.refundBudgetAttempt(job)
            job.modelAttempted = false
          }
          throw error
        }
      }
      const result = await assess({ modelCall: attemptModel, bot: config.bot, source: job.source, baseline: job.baseline, config: target, signal })
      progress()
      await assertActive()
      if (!result || typeof result.needed !== 'boolean') throw fail('docs-model-invalid')
      await api.preflight({ source: job.source, baseline: job.baseline, config: target, expectedBot: job.botFingerprint, signal })
      await store.assessed(job, result)
    } else if (job.phase === 'publish') {
      if (!intent || intent.configHash !== config.configHash) throw fail('docs-scope-changed')
      await api.preflight({ source: intent.source, baseline: intent.baseline, config: target,
        expectedBot: intent.botFingerprint, intent, signal })
      await assertActive()
      const result = await api.advance(intent, { signal, assertActive })
      progress()
      // Record an acknowledged write even if configuration changes immediately afterwards.
      await store.saveStep(job, result)
    } else throw fail('docs-phase-invalid')
  }

  async function tick (input = {}) {
    if (running) return
    running = true
    let signal = AbortSignal.timeout(stepMs)
    let job
    try {
      await store.reconcileTargets(targets)
      signal.throwIfAborted()
      if (!targets.length) {
        health = await store.status()
        healthState?.success('documentation', health)
        return
      }
      const target = targets[turn++ % targets.length]
      const config = await configuration(target, signal)
      const scopes = await store.syncSources({ namespace: target.namespace, targetRepo: target.targetRepo,
        repos: config.repos, configHash: config.configHash })
      signal.throwIfAborted()
      const key = target.namespace + ':' + target.targetRepo
      const position = positions.get(key) || { cycle: 0, repo: 0 }
      positions.set(key, position)
      const discoveryTurn = position.cycle++ % 3 === 0
      if (!discoveryTurn) job = await store.claim({ namespace: target.namespace, targetRepo: target.targetRepo,
        sourceRepos: config.repos, leaseMs: stepMs + 60000, assessmentLeaseMs: assessmentMs + 60000 })
      signal.throwIfAborted()
      if (job?.phase === 'assess') signal = AbortSignal.timeout(assessmentMs)
      const api = createProvider(target, config.bot, { signal, progress })
      if (job) await processJob(job, target, config, api, signal, input.modelCall || modelCall)
      else if (scopes.length) {
        const scope = scopes[position.repo++ % scopes.length]
        const scan = await api.discover(scope.sourceRepo, { cursor: scope.cursor, activatedAt: scope.activatedAt, limit: 200, signal })
        signal.throwIfAborted()
        await store.saveScan(scope, scan)
        progress()
      }
      health = await store.status()
      healthState?.success('documentation', health)
    } catch (error) {
      const code = typeof error.code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(error.code) ? error.code
        : ['TimeoutError', 'AbortError'].includes(error.name) ? error.name : 'unavailable'
      if (job) {
        try {
          if (error.code === 'SENSITIVE_CONTENT') await store.stop(job, error.code, { redact: true })
          else if (staticEvidence.has(error.code)) await store.stop(job, error.code)
          else if (error.code === 'docs-assessment-failed' || (job.phase === 'assess' && job.modelAttempts >= 3 && error.code !== 'budget')) await store.stop(job, 'docs-assessment-failed')
          else if (['docs-scope-changed', 'docs-model-changed'].includes(error.code) && error.replanHash && ['inspect', 'assess'].includes(job.phase)) await store.replan(job, error.replanHash)
          else if (error.code === 'docs-target-changed' && ['inspect', 'assess'].includes(job.phase)) await store.replan(job, job.configHash, true)
          else if (terminal.has(error.code)) await store.stop(job, error.code)
          else await store.defer(job, { ...error, code, ...(job.modelAttempted ? { retryAt: Date.now() + 86400000 } : {}) })
        } catch (saveError) { if (saveError.code !== 'docs-lease-lost') throw saveError }
      }
      health = { ...await store.status(), lastReason: code }
      if (terminal.has(code) || expectedWait.has(code)) healthState?.success('documentation', health)
      else {
        health.error = code
        healthState?.failure('documentation', { code }, health)
      }
    } finally {
      running = false
      progress()
    }
  }

  async function backfill ({ namespace, sourceRepo, targetRepo, number }) {
    if (!repoName(sourceRepo) || !Number.isSafeInteger(number) || number < 1) throw fail('docs-backfill-invalid')
    const target = targets.find(item => item.namespace === namespace && item.targetRepo === targetRepo)
    const config = await configuration(target, AbortSignal.timeout(stepMs))
    if (!config.repos.includes(sourceRepo.toLowerCase())) throw fail('docs-scope-unavailable')
    const scopes = await store.syncSources({ namespace, targetRepo, repos: config.repos, configHash: config.configHash })
    await store.enqueue(scopes.find(item => item.sourceRepo === sourceRepo.toLowerCase()), number)
    return { queued: true }
  }

  return { tick, backfill, get status () { return { ...health } } }
}

module.exports = { createDocsFollowupService, botFingerprint }
