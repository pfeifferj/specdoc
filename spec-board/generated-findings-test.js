const assert = require('node:assert/strict')
const { test } = require('node:test')
const { normalizeFinding } = require('./generated-findings')

const input = () => ({ actor: { kind: 'automation', id: 'review-bot', login: 'Review bot' },
  producer: 'spec-review', kind: 'conflict', body: 'The two requirements select different types for the same input.',
  occurrenceKey: 'f'.repeat(64), evidence: [
    { noteId: 'model', contentHash: 'a'.repeat(64), body: '# Model\n\n**FR-001**: Strings from a document remain strings when loaded into the model.\n\nOther context.', quote: 'Strings from a document remain strings' },
    { noteId: 'format', contentHash: 'b'.repeat(64), body: '# Format\n\n**FR-002**: IP-looking strings become IP values when loaded into the model.', quote: 'IP-looking strings become IP values' }
  ] })

test('one verified clause pair identifies the finding across producer, order and quotation choices', () => {
  const original = normalizeFinding(input())
  const repeated = input()
  repeated.producer = 'checkpoint'
  repeated.kind = 'overlap'
  repeated.body = 'A different explanation of the same conflicting requirements.'
  repeated.evidence.reverse()
  repeated.evidence[0].quote = 'become IP values when loaded into the model'
  repeated.evidence[1].quote = 'remain strings when loaded into the model'
  assert.equal(normalizeFinding(repeated).findingKey, original.findingKey)
  assert.match(original.evidence[0].anchor, /^FR-002:[a-f0-9]{64}$/)
})

test('adjacent requirement items and their wrapped lines have independent identities', () => {
  const first = input()
  first.evidence[0].body = '# Model\n\n- **FR-001**: Keep names stable.\n- **FR-002**: Strings from a document remain strings\n  when loaded into the model.\n- **SC-001**: Preserve addresses.\n'
  const original = normalizeFinding(first)
  assert.match(original.evidence.find(source => source.noteId === 'model').anchor, /^FR-002:/)
  const sibling = structuredClone(first)
  sibling.evidence[0].body = sibling.evidence[0].body.replace('Keep names stable.', 'Keep names unique.')
  assert.equal(normalizeFinding(sibling).findingKey, original.findingKey)
  sibling.evidence[0].quote = 'Keep names unique.'
  assert.notEqual(normalizeFinding(sibling).findingKey, original.findingKey)
  const wrapped = structuredClone(first)
  wrapped.evidence[0].quote = 'when loaded into the model.'
  assert.equal(normalizeFinding(wrapped).findingKey, original.findingKey)
  const spanning = structuredClone(first)
  spanning.evidence[0].quote = 'Keep names stable.\n- **FR-002**: Strings from a document remain strings'
  assert.throws(() => normalizeFinding(spanning), error => error.code === 'review-finding-invalid')
})

test('unrelated source edits retain identity while a changed governing clause creates a new finding', () => {
  const original = normalizeFinding(input())
  const unrelated = input()
  unrelated.evidence[0].body += '\n\nAn unrelated paragraph.'
  unrelated.evidence[0].contentHash = 'c'.repeat(64)
  assert.equal(normalizeFinding(unrelated).findingKey, original.findingKey)
  unrelated.evidence[0].body = unrelated.evidence[0].body.replace('remain strings', 'remain strings unless explicitly typed')
  unrelated.evidence[0].quote = 'Strings from a document remain strings unless explicitly typed'
  assert.notEqual(normalizeFinding(unrelated).findingKey, original.findingKey)
})

test('unverifiable, ambiguous, forged and oversized evidence cannot create a publication blocker', () => {
  for (const edit of [
    value => { value.evidence[0].quote = 'This text was never supplied to the model.' },
    value => { value.evidence[0].body += '\n\n' + value.evidence[0].quote },
    value => { value.evidence[0].body += 'x'.repeat(128001) },
    value => { value.evidence[0].body += '€'.repeat(43000) },
    value => { value.evidence[0].noteId = value.evidence[1].noteId },
    value => { value.actor.kind = 'github' },
    value => { value.occurrenceKey = 'unbound' }
  ]) {
    const value = input()
    edit(value)
    assert.throws(() => normalizeFinding(value), error => error.code === 'review-finding-invalid')
  }
})

test('a credential outside the quoted passage cannot enter a frozen source snapshot', () => {
  const value = input()
  value.evidence[0].body += '\n\nExample token: ghp_' + 'x'.repeat(36)
  assert.throws(() => normalizeFinding(value), error => error.code === 'SENSITIVE_CONTENT')
})

test('consistency reviews count unusable evidence and failed saves without losing later findings', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const Module = require('node:module')
  const file = path.join(__dirname, 'server.js')
  const loaded = new Module(file + '.consistency', module)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(fs.readFileSync(file, 'utf8') + `
    module.exports.consistency = (bot, output, save, specs) => {
      loadBots = async () => [bot];
      callBotJson = async () => output;
      reviewService.recordFinding = save;
      reviewCurrentSource = async id => specs.find(spec => spec.id === id) || null;
      return findOverlap;
    };`, file)
  const specs = [
    { id: 'model', content: '**FR-001**: Strings remain strings.\n**FR-002**: Names remain names.' },
    { id: 'format', content: '**FR-001**: Strings become IP values.' },
    { id: 'validation', content: '**FR-001**: Strings are always rejected.' }
  ].map(spec => ({ ...spec, namespace: 'team/specs', permission: 'editable', admitted: true }))
  const candidate = (a, b, aQuote, bQuote) => ({ a, b, aQuote, bQuote, kind: 'conflict', why: 'These clauses disagree.' })
  const valid = candidate(1, 2, 'Strings remain strings.', 'Strings become IP values.')
  const output = { overlaps: [
    valid,
    candidate(1, 2, 'Strings remain strings.\n**FR-002**: Names remain names.', 'Strings become IP values.'),
    { ...valid, b: 99 },
    candidate(1, 3, 'Strings remain strings.', 'Strings are always rejected.'),
    { ...valid, why: 'The same clause pair with another explanation.' },
    candidate(2, 3, 'Strings become IP values.', 'Strings are always rejected.')
  ] }
  let saves = 0
  const run = loaded.exports.consistency({ name: 'reviewer', namespaces: ['team/specs'] }, output, async finding => {
    saves++
    const ids = finding.evidence.map(source => source.noteId)
    if (ids.includes('model') && ids.includes('validation')) throw Object.assign(new Error('busy'), { status: 409, code: 'review-busy' })
    return { threadId: ids.includes('model') ? '17' : '18' }
  }, specs)
  const result = await run('team/specs', specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1 })), specs)
  assert.equal(saves, 4)
  assert.equal(result.rejected, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.findings, [{ threadId: '17', noteId: 'model' }, { threadId: '18', noteId: 'format' }])
  output.overlaps = [valid]
  const retried = await run('team/specs', specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1 })), specs)
  assert.equal(retried.rejected, 0)
  assert.equal(retried.failed, 0)
  assert.deepEqual(retried.findings, [{ threadId: '17', noteId: 'model' }])
})
