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
      assert.throws(() => request.validate(invalid), /does not match/)
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
  let result = { comments: [] }
  fixture.require = id => id === './model-client'
    ? { endpoint () {}, modelRequest: async (url, payload) => { calls.push({ url, payload }); return result } }
    : id === './model-budget' ? { reserveModelBudget: async (...args) => { reservations.push(args) } }
      : id === './moderation' ? { ...actualRequire(id), assertAutomationContext: async () => {} }
        : actualRequire(id)
  fixture._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.modelFixture={callBotJson,reviewFingerprint,botForm,REVIEW_SCHEMA,OVERLAP_SCHEMA,CHANGELOG_SCHEMA};', file)
  return { ...fixture.exports.modelFixture, calls, reservations, setResult (value) { result = value } }
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

test('effective model settings change review and feedback identities and round-trip through the form', () => {
  const f = serverFixture()
  const bot = { name: 'reviewer', url: 'https://model.example', model: 'example', namespaces: [] }
  const evidence = { hash: 'source', repo: 'example/code', number: 1, headSha: 'head', mergeSha: 'merge' }
  const base = f.reviewFingerprint(bot, 'Source text.', 'context')
  assert.equal(f.reviewFingerprint({ ...bot, prompt: 'Custom review.' }, 'Source text.', 'context'),
    'v3:1bb36a71e5c8aef01f96efdac9dc47fdf5c5d747216f0d629184f8141f7ea36d')
  const feedback = feedbackRunHash(evidence, [], bot)
  for (const options of [{ response_format: 'json_object' }, { reasoning_effort: 'none' }]) {
    assert.notEqual(f.reviewFingerprint({ ...bot, ...options }, 'Source text.', 'context'), base)
    assert.notEqual(feedbackRunHash(evidence, [], { ...bot, ...options }), feedback)
  }
  assert.equal(f.reviewFingerprint({ ...bot, response_format: 'json_schema', reasoning_effort: null }, 'Source text.', 'context'), base)
  const form = f.botForm('csrf', { ...bot, response_format: 'json_object', reasoning_effort: 'none' })
  assert.match(form, /value="json_object" selected/)
  assert.match(form, /value="none" selected/)
})
