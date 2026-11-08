const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { encryptSecret } = require('./model-credentials')
process.env.MODEL_ALLOWED_ORIGINS = 'https://model.test'
process.env.SPECDOC_SECRET_KEY = crypto.randomBytes(32).toString('base64')
const file = path.join(__dirname, 'server.js')
const mod = new Module(file + '.security-model-test', module)
mod.filename = file
mod.paths = Module._nodeModulePaths(__dirname)
const load = mod.require.bind(mod)
const calls = []
let result = { comments: [{ quote: 'q', comment: 'c' }] }
let budgetError = false
let contextError = false
let afterModel = () => {}
mod.require = id => {
  if (id === 'pg') return { Pool: class extends EventEmitter {
    async query () { throw new Error('Unexpected database query in model boundary fixture') }
  } }
  if (id === './moderation') return { ...load(id), assertAutomationContext: async (db, ids) => {
    if (!ids.length) return
    calls.push({ type: 'context', ids })
    if (contextError) throw new Error('Review context is restricted by moderation')
  } }
  if (id === './model-client') return { ...load(id), modelRequest: async (url, payload, options) => {
    calls.push({ type: 'model', url, payload, options })
    afterModel()
    return result
  } }
  if (id === './model-budget') return { ...load(id), reserveModelBudget: async (db, scopes, tokens, options) => {
    if (budgetError) throw new Error('Daily model budget exhausted')
    calls.push({ type: 'budget', scopes, tokens, options })
  } }
  return load(id)
}
mod._compile(fs.readFileSync(file, 'utf8') + `
  Object.assign(module.exports, { callBotJson, findOverlap, summarizeChanges,
    setBots: bots => { loadBots = async () => bots },
    setCurrentSource: read => { reviewCurrentSource = read } });
`, file)

async function main () {
  const { callBot, callBotJson, findOverlap, summarizeChanges, setBots, setCurrentSource, REVIEW_SYSTEM } = mod.exports
  const bot = { name: 'reviewer', url: 'https://model.test', model: 'm1', namespaces: ['team/specs'],
    api_key: encryptSecret('provider-secret', 'reviewer'), prompt: 'custom prompt' }
  assert.deepEqual(await callBot(bot, 'spec body', 'untrusted related instructions'), result.comments)
  assert.deepEqual(calls.map(c => c.type), ['budget', 'model'], 'quota is reserved before sending content')
  const request = calls[1]
  assert.equal(request.options.apiKey, 'provider-secret')
  assert.ok(request.options.signal instanceof AbortSignal)
  assert.deepEqual(request.options.origins, ['https://model.test'])
  assert.equal(request.payload.messages[0].content, 'custom prompt')
  assert.ok(request.payload.messages[1].content.includes('untrusted related instructions'))
  assert.ok(request.payload.messages[1].content.includes('spec body'))
  assert.ok(calls[0].tokens > 3072)
  assert.deepEqual(calls[0].scopes, ['team/specs'])
  assert.equal(request.payload.response_format.type, 'json_schema')
  calls.length = 0
  await callBot({ ...bot, api_key: null, prompt: null }, 'body')
  assert.equal(calls[1].payload.messages[0].content, REVIEW_SYSTEM)
  assert.equal(calls[1].options.apiKey, null)
  for (const name of ['overlap', 'changelog', 'feedback']) {
    calls.length = 0
    await callBotJson(bot, 'system', 'data', name, { type: 'object' }, 100)
    assert.deepEqual(calls.map(c => c.type), ['budget', 'model'])
  }
  calls.length = 0
  await callBot({ ...bot, contextIds: ['note', 'related'] }, 'body')
  assert.deepEqual(calls.map(c => c.type), ['budget', 'context', 'model'], 'context restrictions are checked immediately before dispatch')
  assert.deepEqual(calls[1].ids, ['note', 'related'])
  calls.length = 0
  contextError = true
  await assert.rejects(callBot({ ...bot, contextIds: ['note'] }, 'body'), /restricted/)
  assert.deepEqual(calls.map(c => c.type), ['budget', 'context'])
  contextError = false
  const specs = ['first', 'second', 'outsider'].map(id => ({ id, title: id, namespace: 'team/specs',
    content: id + ' document', permission: 'editable', admitted: id !== 'outsider' }))
  const nodes = specs.map((s, i) => ({ id: s.id, n: i + 1, ns: s.namespace, title: s.title }))
  const currentSources = new Map(specs.filter(spec => spec.admitted).map(spec => [spec.id, spec]))
  setCurrentSource(async id => {
    calls.push({ type: 'source', id })
    return currentSources.get(id) || null
  })
  setBots([bot])
  calls.length = 0
  result = { overlaps: [] }
  await findOverlap('team/specs', nodes, specs)
  assert.deepEqual(calls.map(call => call.type), ['budget', 'context', 'model', 'source', 'source'])
  assert.deepEqual(calls.filter(call => call.type === 'source').map(call => call.id), ['first', 'second'])
  assert.deepEqual(calls.find(c => c.type === 'context').ids, ['first', 'second'])
  assert.ok(!calls.find(c => c.type === 'model').payload.messages[1].content.includes('outsider'))
  for (const changed of [null, { ...specs[1], namespace: 'other/specs' }]) {
    calls.length = 0
    afterModel = () => currentSources.set('second', changed)
    await assert.rejects(findOverlap('team/specs', nodes, specs), { code: 'review-context-restricted' })
    assert.deepEqual(calls.map(call => call.type), ['budget', 'context', 'model', 'source', 'source'])
    afterModel = () => {}
    currentSources.set('second', specs[1])
  }
  calls.length = 0
  result = { summary: '' }
  await summarizeChanges('team/specs', { from: 'v1', added: [{ id: 'first', label: '1', title: 'first' },
    { id: 'outsider', label: '3', title: 'outsider' }], revised: [{ id: 'second', label: '2', title: 'second',
    requirements: { from: 'v1', to: 'v2', added: [], removed: [], changed: [], excerpt: 'revised document' } }],
    retired: [], implemented: [] }, nodes, specs)
  assert.deepEqual(calls.find(c => c.type === 'context').ids, ['first', 'second'], 'revision excerpts also require a final context check')
  assert.ok(!calls.find(c => c.type === 'model').payload.messages[1].content.includes('outsider'))
  calls.length = 0
  budgetError = true
  await assert.rejects(callBot(bot, 'x'), /budget exhausted/)
  assert.equal(calls.length, 0)
  budgetError = false
  await assert.rejects(callBot(bot, '-----BEGIN PRIVATE KEY-----'), /Possible private key/)
  assert.equal(calls.length, 0)
  await assert.rejects(callBot({ ...bot, api_key: 'plaintext' }, 'x'), /migration/)
  await assert.rejects(callBot({ ...bot, url: 'http://model.test' }, 'x'), /HTTPS/)
  result = { wrong: true }
  await assert.rejects(callBot(bot, 'x'), /does not match the requested schema/)
  console.log('model boundary integration: quota, credential, transport, data roles and all consumers passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
