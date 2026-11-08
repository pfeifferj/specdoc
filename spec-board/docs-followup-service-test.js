const assert = require('assert/strict')
const { createDocsFollowupService, botFingerprint } = require('./docs-followup-service')
const { createHealthState } = require('./health-state')

function fixture () {
  const target = { namespace: 'team/specs', targetRepo: 'team/docs', paths: ['guide.md'], exclude: [], bot: 'docs-bot' }
  const bot = { name: 'docs-bot', url: 'https://model.invalid', model: 'model', api_key: 'encrypted-fixture', namespaces: ['team/specs'] }
  const source = { repo: 'team/app', number: 4, mergeSha: 'a'.repeat(40), mergedAt: '2026-11-08T00:00:00Z', complete: true }
  const baseline = { repo: 'team/docs', commit: 'b'.repeat(40), complete: true, files: [{ path: 'guide.md' }] }
  const f = { targets: [target], bot, source, baseline, manual: false, roles: { 'implementation-repos': ['team/app'] }, phase: 'inspect',
    calls: [], stopped: null, deferred: null, assessments: 0, mutations: 0, onInspect: () => {}, onAssess: () => {}, onAdvance: () => {},
    preflightError: null, result: { needed: false, reason: 'Already documented.' }, lease: true, health: createHealthState(),
    modelCalls: 0, modelAttempts: 0, events: [] }
  const store = {
    async reconcileTargets (targets) { f.reconciled = targets.map(({ namespace, targetRepo }) => ({ namespace, targetRepo })) },
    async retireSources (scope) { f.retired = scope },
    async syncSources (input) {
      f.calls.push('sync')
      f.configHash ||= input.configHash
      return input.repos.map(sourceRepo => ({ ...input, sourceRepo, activatedAt: '2026-11-07T00:00:00Z', generation: 1, cursor: null }))
    },
    async saveScan () { f.calls.push('scan') },
    async claim (options) { f.claimOptions = options; return f.stopped ? undefined : { id: '1', phase: f.phase, number: 4, sourceRepo: 'team/app', source: f.source, baseline: f.baseline, manual: f.manual,
      configHash: f.configHash, botFingerprint: f.savedBotHash || botFingerprint(bot), activatedAt: '2026-11-07T00:00:00Z', modelAttempts: f.modelAttempts } },
    async assertLease () { if (!f.lease) throw Object.assign(new Error('expired'), { code: 'docs-lease-lost' }) },
    async saveInputs (job, input) { f.phase = 'assess'; f.savedBotHash = input.botFingerprint },
    async assessed () { f.calls.push('assessed') },
    async intent (job) { return { configHash: job.configHash, botFingerprint: job.botFingerprint, source, baseline,
      proposal: { edits: [{ path: 'guide.md' }] }, stage: f.intentStage || 'prepared' } },
    async saveStep () { f.calls.push('saved-step') },
    async stop (job, reason, { redact = false } = {}) { f.stopped = reason; f.redacted = redact },
    async beginAssessment () {
      if (f.modelAttempts >= 3) throw Object.assign(new Error('Assessment exhausted'), { code: 'docs-assessment-failed' })
      f.events.push('reserve')
      return ++f.modelAttempts
    },
    async refundBudgetAttempt () { f.events.push('refund'); return --f.modelAttempts },
    async replan (job, configHash, delayed) { f.replanned = true; f.delayed = delayed; f.configHash = configHash; f.phase = 'inspect' },
    async defer (job, error) { f.deferred = error.code || 'unavailable'; f.retryAt = error.retryAt },
    async enqueue (scope, number) { f.enqueued = { scope, number } },
    async status () { return { pending: 1 } }
  }
  f.service = createDocsFollowupService({ store, targets: f.targets, roles: async (namespace, fresh) => {
    assert.equal(namespace, 'team/specs'); assert.equal(fresh, true); return f.roles
  }, getBots: async () => [bot], createProvider: () => ({
    async discover () { f.calls.push('discover'); return { cursor: {}, items: [], complete: true } },
    async inspect (repo, number, options) { f.calls.push('inspect'); f.inspectOptions = options; f.onInspect(); return f.source },
    async target () { return f.baseline },
    async preflight () { f.calls.push('preflight'); if (f.preflightError) throw f.preflightError },
    async advance (intent, { assertActive }) { f.passedIntent = intent; f.onAdvance(); await assertActive(); f.mutations++; return { stage: 'branch', branch: 'docs/fixed-key' } }
  }), assess: async ({ modelCall, signal }) => {
    f.assessments++; await modelCall(); f.onAssess(signal); if (f.assessError) throw f.assessError; return f.result
  }, modelCall: async () => {
    if (f.modelError?.code === 'budget') throw f.modelError
    f.events.push('call'); f.modelCalls++
    if (f.modelError) throw f.modelError
    return {}
  }, healthState: f.health })
  return f
}

async function main () {
  {
    const f = fixture()
    f.targets.length = 0
    await f.service.tick()
    assert.deepEqual(f.calls, [], 'disabled deployment performs no scope or API calls')
    assert.deepEqual(f.reconciled, [], 'disabled deployment still retires queued work from removed targets')
  }
  for (const roles of [null, {}, { 'implementation-repos': ['team/app', '../bad'] }]) {
    const f = fixture(); f.roles = roles
    await f.service.tick()
    assert.deepEqual(f.calls, [], 'missing scope cannot fall back to the specs repository')
    assert.equal(f.service.status.error, 'docs-scope-unavailable')
  }
  {
    const f = fixture(); f.roles = { 'implementation-repos': [] }
    await f.service.tick()
    assert.deepEqual(f.calls, ['sync'], 'an explicit empty source list deactivates prior sources without GitHub discovery')
    assert.equal(f.service.status.error, undefined)
  }
  {
    const f = fixture(); f.bot.enabled = false; f.roles = { 'implementation-repos': ['team/new'] }
    await f.service.tick()
    assert.deepEqual(f.retired.repos, ['team/new'], 'fresh source removal is applied while its bot is disabled')
    assert.deepEqual(f.calls, [], 'an unavailable bot cannot activate new sources')
    assert.equal(f.service.status.error, 'docs-bot-unavailable')
  }
  {
    const f = fixture()
    await f.service.tick()
    await f.service.tick()
    assert.equal(f.phase, 'assess')
    assert.equal(f.inspectOptions.activatedAt, '2026-11-07T00:00:00Z')
    assert.equal(f.inspectOptions.manual, false)
    assert.equal(f.assessments, 0, 'inspection and model assessment use separate bounded ticks')
    await f.service.tick()
    assert.equal(f.assessments, 1)
    assert.ok(f.calls.includes('assessed'))
    assert.equal(f.mutations, 0, 'a complete no-change assessment creates nothing')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.preflightError = Object.assign(new Error('private source'), { code: 'inaccessible' })
    await f.service.tick(); await f.service.tick()
    assert.equal(f.assessments, 0, 'cached public text is rechecked before sending it to the model')
    assert.equal(f.deferred, 'inaccessible')
    assert.ok(!f.calls.includes('assessed'))
  }
  for (const code of ['docs-source-changed', 'docs-source-branch', 'docs-generated-source', 'docs-proposal-changed', 'docs-proposal-removed',
    'docs-branch-changed', 'docs-branch-collision', 'docs-comment-changed']) {
    const f = fixture(); f.phase = 'assess'
    f.preflightError = Object.assign(new Error('changed remote state'), { code })
    await f.service.tick(); await f.service.tick()
    assert.equal(f.stopped, code)
    assert.equal(f.deferred, null)
    assert.equal(f.assessments, 0, 'remote drift must not assess or publish stale evidence')
  }
  for (const phase of ['assess', 'publish']) {
    const f = fixture(); f.phase = phase
    f.preflightError = Object.assign(new Error('docs advanced'), { code: 'docs-target-changed' })
    await f.service.tick(); await f.service.tick()
    if (phase === 'assess') {
      assert.equal(f.phase, 'inspect')
      assert.equal(f.delayed, true)
      assert.equal(f.stopped, null)
    } else {
      assert.equal(f.stopped, 'docs-target-changed')
      assert.equal(f.replanned, undefined, 'a prepared intent may already have made an unacknowledged write')
    }
    assert.equal(f.assessments, 0)
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.onAssess = () => { f.preflightError = Object.assign(new Error('docs advanced during model call'), { code: 'docs-target-changed' }) }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.delayed, true)
    assert.ok(!f.calls.includes('assessed'), 'a changed target cannot become a no-change decision or a stale publication intent')
  }
  for (const manual of [false, true]) {
    const f = fixture(); f.manual = manual
    f.source = { ...f.source, mergedAt: '2001-01-01T00:00:00Z' }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.phase, manual ? 'assess' : 'inspect')
    assert.equal(f.stopped, manual ? null : 'docs-before-activation', 'only explicit backfill can inspect historical merges')
  }
  {
    const f = fixture(); f.baseline = { ...f.baseline, files: [] }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.deferred, 'incomplete')
    assert.equal(f.assessments, 0, 'missing documentation cannot be classified as already covered')
  }
  {
    const f = fixture(); f.phase = 'assess'; f.result = { incomplete: true }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.deferred, 'docs-model-invalid')
    assert.ok(!f.calls.includes('assessed'), 'missing model output cannot become no-change')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.onAssess = () => { f.bot.api_key = 'rotated-encrypted-fixture' }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.stopped, null)
    assert.equal(f.replanned, true)
    assert.equal(f.phase, 'inspect')
    assert.ok(!f.calls.includes('assessed'), 'credential changes invalidate an in-flight analysis')
  }
  for (const [field, before, after] of [
    ['endpoint_mode', 'base', 'full'],
    ['temperature', undefined, 0],
    ['temperature', undefined, null],
    ['temperature', 0, null],
    ['token_limit_parameter', 'max_tokens', 'max_completion_tokens'],
    ['response_format', 'json_schema', 'json_object'],
    ['reasoning_effort', null, 'none']
  ]) {
    for (const when of ['inspect', 'before-assessment', 'during-assessment']) {
      const f = fixture()
      f.bot[field] = before
      if (when === 'inspect') f.onInspect = () => { f.bot[field] = after }
      else {
        f.phase = 'assess'
        f.savedBotHash = botFingerprint(f.bot)
        if (when === 'before-assessment') f.bot[field] = after
        else f.onAssess = () => { f.bot[field] = after }
      }
      await f.service.tick(); await f.service.tick()
      assert.equal(f.replanned, true, `${field} changes ${when} require fresh model provenance`)
      assert.equal(f.phase, 'inspect')
      assert.equal(f.modelCalls, when === 'during-assessment' ? 1 : 0)
      assert.equal(f.modelAttempts, when === 'during-assessment' ? 1 : 0, 'replanning retains spent model attempts')
      assert.ok(!f.calls.includes('assessed'), 'a provider change cannot preserve a stale assessment')
      if (when === 'inspect') assert.equal(f.savedBotHash, undefined, 'changed inspection cannot save stale model provenance')
    }
  }
  for (const stage of ['prepared', 'pr']) {
    const f = fixture(); f.phase = 'publish'; f.intentStage = stage
    f.savedBotHash = botFingerprint(f.bot)
    await f.service.tick()
    const originalScope = f.configHash
    f.bot.api_key = 'rotated-encrypted-fixture'
    f.bot.model = 'new-model'
    f.bot.endpoint_mode = 'full'
    f.bot.temperature = null
    f.bot.token_limit_parameter = 'max_completion_tokens'
    f.bot.response_format = 'json_object'
    f.bot.reasoning_effort = 'none'
    f.onAdvance = () => { f.bot.prompt = 'A changed prompt.' }
    await f.service.tick()
    assert.equal(f.stopped, null)
    assert.equal(f.mutations, 1, 'model settings cannot abandon an already prepared proposal')
    assert.equal(f.assessments, 0)
    assert.equal(f.passedIntent.botFingerprint, f.savedBotHash, 'the original model provenance remains attached')
    assert.equal(f.configHash, originalScope)
  }
  for (const change of ['add', 'remove-unrelated', 'revoke']) {
    const f = fixture(); f.phase = 'publish'
    if (change === 'remove-unrelated') f.targets[0].paths.push('unused.md')
    await f.service.tick()
    f.targets[0].paths = change === 'add' ? ['guide.md', 'new.md'] : change === 'revoke' ? ['other.md'] : ['guide.md']
    await f.service.tick()
    assert.equal(f.mutations, change === 'revoke' ? 0 : 1)
    assert.equal(f.stopped, change === 'revoke' ? 'docs-scope-changed' : null, 'publication checks only paths actually changed by its proposal')
  }
  for (const when of ['before', 'during']) {
    const f = fixture(); f.phase = 'assess'
    if (when === 'before') f.targets[0].paths.push('new.md')
    else f.onAssess = () => { f.targets[0].paths.push('new.md') }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.replanned, true)
    assert.equal(f.modelAttempts, when === 'before' ? 0 : 1, 'automatic replanning does not reset spent model attempts')
    assert.ok(!f.calls.includes('assessed'), 'assessment covers the current allowed documentation set')
  }
  for (const code of ['budget', 'incomplete', 'docs-evidence-limit', 'docs-evidence-unsupported', 'docs-evidence-mismatch', 'docs-proposal-changed', 'docs-before-activation']) {
    const f = fixture(); f.phase = 'assess'
    f.preflightError = Object.assign(new Error('Known blocked work'), { code })
    await f.service.tick(); await f.service.tick()
    assert.equal(f.health.get('documentation').ok, true, 'expected job state must not mark the worker unhealthy: ' + code)
    assert.equal(f.service.status.lastReason, code)
    if (code.startsWith('docs-evidence-')) assert.equal(f.stopped, code, 'unsupported evidence waits for explicit backfill')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.preflightError = Object.assign(new Error('Provider unavailable'), { code: 'docs-github-unavailable' })
    await f.service.tick(); await f.service.tick()
    assert.equal(f.health.get('documentation').ok, false)
    assert.equal(f.service.status.error, 'docs-github-unavailable')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.assessError = Object.assign(new Error('Malformed model result'), { code: 'docs-model-invalid' })
    for (let tick = 0; tick < 12; tick++) await f.service.tick()
    assert.equal(f.modelCalls, 3, 'invalid model output has a finite attempt budget')
    assert.equal(f.modelAttempts, 3)
    assert.equal(f.stopped, 'docs-assessment-failed')
    assert.ok(f.retryAt >= Date.now() + 86300000, 'failed model attempts do not retry hourly')
    assert.deepEqual(f.events, ['reserve', 'call', 'reserve', 'call', 'reserve', 'call'], 'attempts are persisted before model dispatch')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.modelError = Object.assign(new Error('Daily budget unavailable'), { code: 'budget' })
    for (let tick = 0; tick < 6; tick++) await f.service.tick()
    assert.equal(f.modelCalls, 0)
    assert.equal(f.modelAttempts, 0, 'a confirmed no-call budget deferral refunds its model attempt')
    assert.equal(f.retryAt, undefined, 'ordinary budget recovery uses the regular defer interval')
    assert.equal(f.stopped, null)
    f.modelError = Object.assign(new Error('Model transport failed'), { code: 'model-provider' })
    for (let tick = 0; tick < 6; tick++) await f.service.tick()
    assert.equal(f.modelCalls, 3)
    assert.equal(f.stopped, 'docs-assessment-failed')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.modelError = new DOMException('The model request timed out', 'TimeoutError')
    await f.service.tick(); await f.service.tick()
    assert.equal(f.service.status.lastReason, 'TimeoutError', 'DOMException numeric codes are not status reasons')
    assert.equal(f.health.get('documentation').error, 'TimeoutError')
    assert.equal(f.health.get('documentation').ok, false)
    for (let tick = 0; tick < 10; tick++) await f.service.tick()
    assert.equal(f.modelCalls, 3, 'timed-out model requests consume the durable attempt budget')
    assert.equal(f.stopped, 'docs-assessment-failed')
  }
  {
    const f = fixture(); f.phase = 'assess'
    f.modelError = Object.assign(new Error('Private text must not be retained'), { code: 'SENSITIVE_CONTENT' })
    await f.service.tick(); await f.service.tick()
    assert.equal(f.stopped, 'SENSITIVE_CONTENT')
    assert.equal(f.redacted, true)
    assert.ok(!f.calls.includes('assessed'))
  }
  {
    const originalTimeout = AbortSignal.timeout
    let clock = 0
    const deadlines = []
    AbortSignal.timeout = delay => {
      const controller = new AbortController()
      deadlines.push({ controller, at: clock + delay })
      return controller.signal
    }
    try {
      const f = fixture(); f.phase = 'assess'
      f.onAssess = () => {
        clock += 70000
        for (const deadline of deadlines) if (deadline.at <= clock) deadline.controller.abort()
      }
      await f.service.tick(); await f.service.tick()
      assert.ok(f.calls.includes('assessed'), 'an assessment may outlast the ordinary one-minute API step')
      assert.equal(f.claimOptions.leaseMs, 120000)
      assert.equal(f.claimOptions.assessmentLeaseMs, 240000, 'the assessment lease outlives its three-minute deadline')
    } finally { AbortSignal.timeout = originalTimeout }
  }
  for (const change of ['scope', 'lease']) {
    const f = fixture(); f.phase = 'publish'
    f.onAdvance = () => { if (change === 'scope') f.roles = { 'implementation-repos': ['team/other'] }; else f.lease = false }
    await f.service.tick(); await f.service.tick()
    assert.equal(f.mutations, 0, 'the last write guard catches ' + change + ' changes')
    assert.ok(!f.calls.includes('saved-step'))
  }
  {
    const f = fixture()
    await assert.rejects(f.service.backfill({ namespace: 'team/specs', targetRepo: 'team/docs', sourceRepo: 'unrelated/repo', number: 4 }), { code: 'docs-scope-unavailable' })
    await f.service.backfill({ namespace: 'team/specs', targetRepo: 'team/docs', sourceRepo: 'team/app', number: 4 })
    assert.equal(f.enqueued.number, 4)
    assert.equal(f.enqueued.scope.sourceRepo, 'team/app')
  }
  assert.notEqual(botFingerprint({ name: 'bot', response_format: 'json_object' }), botFingerprint({ name: 'bot', response_format: 'json_schema' }))
  assert.notEqual(botFingerprint({ name: 'bot', reasoning_effort: null }), botFingerprint({ name: 'bot', reasoning_effort: 'none' }))
  assert.equal(botFingerprint({ name: 'bot' }), botFingerprint({ name: 'bot', response_format: 'json_schema',
    reasoning_effort: null, endpoint_mode: 'base', temperature: 0.2, token_limit_parameter: 'max_tokens' }), 'explicit defaults retain model provenance')
  assert.equal(botFingerprint({ name: 'bot', namespaces: ['team/specs', 'other/specs'] }),
    botFingerprint({ name: 'bot', namespaces: ['other/specs', 'team/specs'] }), 'namespace order does not change model provenance')
  assert.notEqual(botFingerprint({ name: 'bot', api_key: 'original' }), botFingerprint({ name: 'bot', api_key: 'rotated' }))
  console.log('documentation follow-up service tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
