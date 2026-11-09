const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { test } = require('node:test')
const { jsonRequest, modelOptions } = require('./model-output')
const { feedbackRunHash, FEEDBACK_MODEL_SCHEMA } = require('./feedback')
const { SUMMARY_SCHEMA } = require('./revision-summary')

const schema = { type: 'object', additionalProperties: false,
  properties: { comments: { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false,
    properties: { quote: { type: 'string', maxLength: 20 }, severity: { type: 'string', enum: ['issue', 'question'] } },
    required: ['quote', 'severity'] } } }, required: ['comments'] }

test('default model request preserves schema mode and endpoint reasoning defaults', () => {
  const request = jsonRequest({ model: 'example' }, 'Review this spec.', 'Source text.', 'review', schema, 3072)
  assert.deepEqual(request.payload, {
    model: 'example', temperature: 0.2, max_tokens: 3072,
    messages: [{ role: 'system', content: 'Review this spec.' }, { role: 'user', content: 'Source text.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'review', schema } }
  })
  assert.deepEqual(modelOptions({ response_format: 'json_schema', reasoning_effort: null }), modelOptions({}))
})

test('JSON object mode supplies the schema and can disable reasoning within the same output limit', () => {
  const request = jsonRequest({ model: 'example', response_format: 'json_object', reasoning_effort: 'none' },
    'Review this spec.', 'Source text.', 'review', schema, 3072)
  assert.deepEqual(request.payload.response_format, { type: 'json_object' })
  assert.equal(request.payload.reasoning_effort, 'none')
  assert.equal(request.payload.max_tokens, 3072)
  assert.ok(request.payload.messages[0].content.startsWith('Review this spec.\n'))
  assert.ok(request.payload.messages[0].content.endsWith(JSON.stringify(schema)))
  assert.match(request.payload.messages[0].content, /json/i)
  assert.equal(request.payload.messages[1].content, 'Source text.')
})

test('model parameters can omit temperature and use either bounded output limit', () => {
  for (const temperature of [null, 0, 2]) {
    for (const token_limit_parameter of ['max_tokens', 'max_completion_tokens']) {
      const request = jsonRequest({ temperature, token_limit_parameter, endpoint_mode: 'full' },
        'Review.', 'Source.', 'review', schema, 3072)
      assert.equal(request.payload[token_limit_parameter], 3072)
      assert.equal(Object.hasOwn(request.payload, token_limit_parameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'), false)
      assert.equal(Object.hasOwn(request.payload, 'temperature'), temperature !== null)
      if (temperature !== null) assert.equal(request.payload.temperature, temperature)
      assert.equal(request.options.endpoint_mode, 'full')
      assert.deepEqual(request.validate({ comments: [] }), { comments: [] })
    }
  }
})

test('unsupported request settings fail before sending a request', () => {
  for (const options of [
    { endpoint_mode: 'guess' }, { token_limit_parameter: 'unlimited' },
    ...[NaN, Infinity, -Infinity, -0.1, 2.1, false, [], {}, '0.2'].map(temperature => ({ temperature }))
  ]) assert.throws(() => jsonRequest(options, 'Review.', 'Source.', 'review', schema, 3072), /Unsupported|temperature/)
})

test('both output modes reject invalid structures without changing accepted values', () => {
  for (const response_format of ['json_schema', 'json_object']) {
    const request = jsonRequest({ response_format }, 'Review.', 'Source.', 'review', schema, 100)
    const result = { comments: [{ quote: 'Exact text', severity: 'issue' }] }
    assert.equal(request.validate(result), result)
    assert.deepEqual(request.validate({ comments: [] }), { comments: [] })
    for (const invalid of [{}, { comments: 'none' }, { comments: [null] },
      { comments: [{ quote: 'Exact text' }] }, { comments: [{ quote: 'x'.repeat(21), severity: 'issue' }] },
      { comments: [{ quote: 'Exact text', severity: 'invented' }] },
      { comments: [result.comments[0], result.comments[0]] }, { comments: [], approval: true }]) {
      assert.throws(() => request.validate(invalid), { code: 'model-output-invalid', message: 'Model result does not match the requested schema' })
    }
  }
  assert.throws(() => jsonRequest({}, '', '', 'bad', { type: 'object', unsupportedKeyword: true }, 100), /unknown keyword/)
  for (const invalid of [{ response_format: 'text' }, { response_format: false }, { reasoning_effort: 'unbounded' }]) {
    assert.throws(() => modelOptions(invalid), /Unsupported/)
  }
})

function serverFixture () {
  const file = path.join(__dirname, 'server.js')
  const fixture = new Module(file + '.model-test', module)
  fixture.filename = file
  fixture.paths = Module._nodeModulePaths(__dirname)
  const actualRequire = fixture.require.bind(fixture)
  const calls = []
  const reservations = []
  const refunds = []
  let onReservation = () => {}
  let result = { comments: [] }
  fixture.require = id => id === './model-client'
    ? { endpoint () {}, requestNotSent: () => false, modelRequest: async (url, payload, options) => { calls.push({ url, payload, options }); return result } }
    : id === './model-budget' ? { reserveModelBudget: async (...args) => {
      reservations.push(args)
      await onReservation()
      return { releaseTokens: async () => { refunds.push(args) } }
    } }
      : id === './moderation' ? { ...actualRequire(id), assertAutomationContext: async () => {} }
        : actualRequire(id)
  fixture._compile(fs.readFileSync(file, 'utf8') + `
    module.exports.modelFixture={callBotJson,callBot,findOverlap,splitFindings,injectComments,
      reviewFingerprint,automationSettingsFingerprint,botForm,REVIEW_SCHEMA,OVERLAP_SCHEMA,CHANGELOG_SCHEMA,
      REVIEW_MAX_COMMENTS,OVERLAP_MAX_FINDINGS,
      sources: sources => { reviewCurrentSource = async id => sources.find(source => source.id === id) },
      saveFinding: save => { reviewService.recordFinding = save }};
  `, file)
  return { ...fixture.exports.modelFixture, calls, reservations, refunds, setResult (value) { result = value },
    onReservation (callback) { onReservation = callback } }
}

test('review and feedback calls share the configured transport, schema checks and actual request budget', async () => {
  const f = serverFixture()
  const bot = { name: 'reviewer', url: 'https://model.example', model: 'example', namespaces: ['example/specs'],
    response_format: 'json_object', reasoning_effort: 'none' }
  assert.deepEqual(await f.callBotJson(bot, 'Review.', '\n\t"\\'.repeat(5000), 'review', f.REVIEW_SCHEMA, 3072), { comments: [] })
  f.setResult({ proposals: [] })
  await f.callBotJson(bot, 'Feedback.', 'Evidence.', 'feedback', FEEDBACK_MODEL_SCHEMA, 5000)
  assert.equal(f.calls.length, 2)
  for (let index = 0; index < f.calls.length; index++) {
    const { payload } = f.calls[index]
    assert.deepEqual(payload.response_format, { type: 'json_object' })
    assert.equal(payload.reasoning_effort, 'none')
    assert.ok(f.reservations[index][2] >= Buffer.byteLength(JSON.stringify(payload)) + payload.max_tokens)
  }
  f.setResult({ comments: [{ quote: 'source', comment: 42 }] })
  await assert.rejects(f.callBotJson(bot, 'Review.', 'Source.', 'review', f.REVIEW_SCHEMA, 3072), /does not match/)
  f.setResult({ proposals: 'invalid' })
  await assert.rejects(f.callBotJson(bot, 'Feedback.', 'Evidence.', 'feedback', FEEDBACK_MODEL_SCHEMA, 5000), /does not match/)
  f.setResult({ change: 'Change.', reason: null, changeQuotes: [{ source: 'after', quote: 'Source.' }], reasonQuotes: [], author: 'invented' })
  await assert.rejects(f.callBotJson(bot, 'Summary.', 'Source.', 'summary', SUMMARY_SCHEMA, 1800), /does not match/)
  for (const taskSchema of [f.REVIEW_SCHEMA, f.OVERLAP_SCHEMA, f.CHANGELOG_SCHEMA, FEEDBACK_MODEL_SCHEMA, SUMMARY_SCHEMA]) {
    assert.doesNotThrow(() => jsonRequest(bot, '', '', 'task', taskSchema, 100))
  }
})

test('review gateway retains usable findings beside malformed items and enforces its item limit', async () => {
  for (const response_format of ['json_schema', 'json_object']) {
    const f = serverFixture()
    const bot = { name: 'reviewer', url: 'https://model.example', model: 'example',
      namespaces: ['example/specs'], response_format }
    const source = 'Strings remain strings in the model.'
    const inline = { quote: source, severity: 'question', comment: 'Clarify the string boundary.',
      conflictsWith: null, conflictQuote: null }
    const shared = { quote: source, comment: 'The same string has conflicting types.',
      conflictsWith: '2', conflictQuote: 'Strings become IP values.' }
    const malformed = [null, { ...inline, comment: 42 }, { ...shared, comment: {} }]
    const comments = [inline, ...malformed, shared, ...Array(f.REVIEW_MAX_COMMENTS - malformed.length - 2).fill(null),
      { quote: source, comment: 'This exceeds the review limit.' }]
    f.setResult({ comments })
    const received = await f.callBot(bot, source)
    const split = f.splitFindings(received, ['2'], source)
    assert.deepEqual(split.notes, [inline])
    assert.equal(split.conflicts.length, 1)
    assert.equal(split.conflicts[0].peerQuote, shared.conflictQuote)
    assert.match(f.injectComments(source, split.notes, bot.name), /Clarify the string boundary/)
    assert.equal(f.calls.length, 1)
    const payload = f.calls[0].payload
    if (response_format === 'json_schema') assert.deepEqual(payload.response_format.json_schema.schema, f.REVIEW_SCHEMA)
    else assert.ok(payload.messages[0].content.endsWith(JSON.stringify(f.REVIEW_SCHEMA)))
    await assert.rejects(f.callBotJson(bot, 'Review.', source, 'review', f.REVIEW_SCHEMA, 3072), /does not match/)
    for (const output of [null, {}, { comments: null }, { comments: {} }]) {
      f.setResult(output)
      await assert.rejects(f.callBot(bot, source), /does not match/)
    }
  }
})

test('consistency gateway saves valid findings and counts rejected items without rerunning the model', async () => {
  for (const response_format of ['json_schema', 'json_object']) {
    const f = serverFixture()
    const bot = { name: 'reviewer', url: 'https://model.example', model: 'example',
      namespaces: ['example/specs'], response_format }
    const specs = [
      { id: 'model', content: '**FR-001**: Strings remain strings in the model.' },
      { id: 'format', content: '**FR-002**: Strings become IP values in the model.' }
    ].map(spec => ({ ...spec, namespace: 'example/specs', admitted: true, permission: 'freely' }))
    const nodes = specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1 }))
    f.sources(specs)
    const saved = []
    f.saveFinding(async finding => { saved.push(finding); return { threadId: '17' } })
    const valid = { a: 1, b: 2, kind: 'conflict', aQuote: 'Strings remain strings',
      bQuote: 'Strings become IP values', why: 'The same input has incompatible types.' }
    const malformed = [null, { ...valid, a: '1' }, { ...valid, kind: 'contradiction' },
      { ...valid, aQuote: 'FR-001' }, { ...valid, bQuote: null }, { ...valid, why: 'x'.repeat(2001) }]
    const overlaps = [valid, ...malformed, ...Array(f.OVERLAP_MAX_FINDINGS - malformed.length - 1).fill(null), valid]
    f.setResult({ overlaps })
    const result = await f.findOverlap('example/specs', nodes, specs, bot)
    assert.deepEqual(result.findings, [{ threadId: '17', noteId: 'model' }])
    assert.equal(saved.length, 1)
    assert.equal(result.rejected, overlaps.length - 1)
    assert.equal(result.failed, 0)
    assert.equal(f.calls.length, 1)
    const payload = f.calls[0].payload
    if (response_format === 'json_schema') assert.deepEqual(payload.response_format.json_schema.schema, f.OVERLAP_SCHEMA)
    else assert.ok(payload.messages[0].content.endsWith(JSON.stringify(f.OVERLAP_SCHEMA)))
    for (const output of [null, {}, { overlaps: null }, { overlaps: {} }]) {
      f.setResult(output)
      await assert.rejects(f.findOverlap('example/specs', nodes, specs, bot), /does not match/)
    }
    assert.equal(saved.length, 1)
  }
})

test('effective model settings change review and feedback identities and round-trip through the form', () => {
  const f = serverFixture()
  const bot = { name: 'reviewer', url: 'https://model.example', model: 'example', namespaces: [] }
  const evidence = { hash: 'source', repo: 'example/code', number: 1, headSha: 'head', mergeSha: 'merge' }
  const base = f.reviewFingerprint(bot, 'Source text.', 'context')
  assert.equal(f.reviewFingerprint({ ...bot, prompt: 'Custom review.' }, 'Source text.', 'context'),
    'v5:1bb36a71e5c8aef01f96efdac9dc47fdf5c5d747216f0d629184f8141f7ea36d')
  const feedback = feedbackRunHash(evidence, [], bot)
  assert.match(base, /^v5:[a-f0-9]{64}$/)
  assert.equal(feedback, 'af69f61e22e86f8601fa6d4b1579405cab7394af606bb79891acea69dabc028b')
  const existingOptions = { ...bot, response_format: 'json_object', reasoning_effort: 'none' }
  assert.notEqual(f.reviewFingerprint(existingOptions, 'Source text.', 'context'), base)
  assert.equal(feedbackRunHash(evidence, [], existingOptions), '2360ab57a50e6b2539f650f35174bcdaf4fbd8c47e2771ef78909cce0393a9ab')
  for (const options of [{ response_format: 'json_object' }, { reasoning_effort: 'none' },
    { endpoint_mode: 'full' }, { temperature: null }, { temperature: 0 }, { token_limit_parameter: 'max_completion_tokens' }]) {
    assert.notEqual(f.reviewFingerprint({ ...bot, ...options }, 'Source text.', 'context'), base)
    assert.notEqual(feedbackRunHash(evidence, [], { ...bot, ...options }), feedback)
  }
  assert.equal(f.reviewFingerprint({ ...bot, response_format: 'json_schema', reasoning_effort: null }, 'Source text.', 'context'), base)
  const explicitDefaults = { ...bot, endpoint_mode: 'base', temperature: 0.2, token_limit_parameter: 'max_tokens' }
  assert.equal(f.reviewFingerprint(explicitDefaults, 'Source text.', 'context'), base)
  assert.equal(feedbackRunHash(evidence, [], explicitDefaults), feedback)
  const form = f.botForm('csrf', { ...bot, response_format: 'json_object', reasoning_effort: 'none' })
  assert.match(form, /value="json_object" selected/)
  assert.match(form, /value="none" selected/)
  assert.match(f.botForm('csrf', { ...bot, temperature: null }), /name="temperature"[^>]*value=""/)
  assert.match(f.botForm('csrf', { ...bot, temperature: 0 }), /name="temperature"[^>]*value="0"/)
})

test('shared findings retain all effective provider settings in their authorization identity', () => {
  const f = serverFixture()
  const bot = { name: 'reviewer', url: 'https://model.example', model: 'example' }
  const defaults = { response_format: 'json_schema', reasoning_effort: null, endpoint_mode: 'base',
    temperature: 0.2, token_limit_parameter: 'max_tokens' }
  for (const producer of ['spec-review', 'checkpoint']) {
    const base = f.automationSettingsFingerprint(bot, producer)
    assert.equal(f.automationSettingsFingerprint({ ...bot, ...defaults }, producer), base)
    const changed = [{ response_format: 'json_object' }, { reasoning_effort: 'none' },
      { endpoint_mode: 'full' }, { temperature: null }, { temperature: 0 }, { token_limit_parameter: 'max_completion_tokens' }]
    const hashes = changed.map(options => f.automationSettingsFingerprint({ ...bot, ...options }, producer))
    assert.ok(hashes.every(hash => hash !== base))
    assert.equal(new Set(hashes).size, changed.length)
  }
})

test('configured completion requests retain the full serialized request and output budget', async () => {
  const f = serverFixture()
  const controller = new AbortController()
  const bot = { name: 'reviewer', url: 'https://model.example/compatible/chat/completions/', model: 'example',
    namespaces: ['example/specs'], endpoint_mode: 'full', temperature: null, token_limit_parameter: 'max_completion_tokens' }
  await f.callBotJson(bot, 'Review.', 'Source.', 'review', schema, 3072, { signal: controller.signal })
  const { url, payload, options } = f.calls[0]
  assert.equal(url, bot.url)
  assert.equal(options.endpointMode, 'full')
  assert.equal(payload.max_completion_tokens, 3072)
  assert.equal(Object.hasOwn(payload, 'max_tokens'), false)
  assert.equal(Object.hasOwn(payload, 'temperature'), false)
  assert.ok(f.reservations[0][2] >= Buffer.byteLength(JSON.stringify(payload)) + 3072)
  assert.equal(options.signal.aborted, false)
  controller.abort(new Error('Documentation lease lost'))
  assert.equal(options.signal.aborted, true)
  assert.equal(options.signal.reason, controller.signal.reason)
})

for (const stage of ['before', 'during budget reservation']) {
  test(`a cancelled documentation request ${stage} never reaches the configured model`, async () => {
    const f = serverFixture()
    const controller = new AbortController()
    const reason = new Error('Documentation lease lost')
    if (stage === 'before') controller.abort(reason)
    else f.onReservation(() => controller.abort(reason))
    const bot = { name: 'reviewer', url: 'https://model.example/custom/chat/completions', model: 'example',
      namespaces: ['example/specs'], endpoint_mode: 'full', response_format: 'json_object',
      temperature: null, token_limit_parameter: 'max_completion_tokens' }
    await assert.rejects(f.callBotJson(bot, 'Review.', 'Source.', 'review', schema, 3072,
      { signal: controller.signal }), error => error === reason)
    assert.equal(f.calls.length, 0)
    assert.equal(f.reservations.length, stage === 'before' ? 0 : 1)
    assert.equal(f.refunds.length, stage === 'before' ? 0 : 1)
  })
}
