'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkRules } = require('../lib/context/preview-rules')

const evidence = { source: 'policy', sha256: 'a'.repeat(64), startLine: 3, endLine: 3, text: 'The model must not depend on the document layer.\n' }
const rule = () => ({ id: 'model-boundary', governing: { source: 'policy', selector: { label: 'FR-001' } }, type: 'forbid-relation', relation: 'implementation', from: ['model'], to: ['documents'] })
const context = (relations = []) => ({ candidateIds: new Set(['policy', 'model', 'documents', 'other']), relations, resolve: () => ({ ...evidence }) })
const exception = version => ({ rule: 'model-boundary', version, scope: ['model'], stage: 'foundation', owner: 'Maintainer', rationale: 'Temporary adapter', decision: 'Review record 17', revisit: 'Review before the next release' })
const errors = result => result.diagnostics.filter(item => item.severity === 'error').map(item => item.code)
const version = () => checkRules({ rules: [rule()] }, context()).ruleChecks[0].version

test('a valid narrow exception never erases a forbidden declared relationship', () => {
  const result = checkRules({ rules: [rule()], exceptions: [exception(version())], stage: 'foundation' }, context([{ type: 'implementation', from: 'model', to: 'documents' }]))
  assert.deepEqual(errors(result), ['FORBIDDEN_RELATION'])
  assert.equal(result.ruleChecks[0].status, 'failed')
  assert.equal(result.ruleChecks[0].declarationOnly, true)
  assert.equal(result.ruleChecks[0].violations.length, 1)
  assert.equal(result.exceptions[0].valid, true)
  assert.equal(result.exceptions[0].authority, 'caller-declared-unverified')
  assert.equal(result.exceptions[0].suppressesViolation, false)
  assert.ok(result.diagnostics.some(item => item.code === 'EXCEPTION_AUTHORITY_UNVERIFIED' && item.severity === 'warning'))
})

test('rule versions cover governing bytes and normalize declaration key order and default required', () => {
  const first = rule()
  const second = Object.fromEntries(Object.entries({ ...first, required: true }).reverse())
  const original = checkRules({ rules: [first] }, context()).ruleChecks[0]
  const reordered = checkRules({ rules: [second] }, { ...context(), resolve: () => Object.fromEntries(Object.entries(evidence).reverse()) }).ruleChecks[0]
  assert.equal(original.version, reordered.version)
  const movedPresentation = checkRules({ rules: [first] }, { ...context(), resolve: () => ({ ...evidence, evidence: 'excerpt-99', side: 'candidate' }) }).ruleChecks[0]
  assert.equal(original.version, movedPresentation.version)
  const changed = checkRules({ rules: [first] }, { ...context(), resolve: () => ({ ...evidence, text: 'A revised boundary.\n' }) }).ruleChecks[0]
  assert.notEqual(original.version, changed.version)
  const result = checkRules({ rules: [first], exceptions: [exception(original.version)], stage: 'foundation' }, { ...context(), resolve: () => ({ ...evidence, text: 'A revised boundary.\n' }) })
  assert.ok(errors(result).includes('EXCEPTION_VERSION_MISMATCH'))
})

test('exceptions reject unknown rules, wrong versions and sources outside selected scope', () => {
  for (const [patch, code] of [
    [{ rule: 'unknown' }, 'EXCEPTION_RULE_UNKNOWN'],
    [{ version: 'b'.repeat(64) }, 'EXCEPTION_VERSION_MISMATCH'],
    [{ scope: ['other'] }, 'EXCEPTION_SCOPE_MISMATCH'],
    [{ scope: ['model', 'model'] }, 'EXCEPTION_SCOPE_MISMATCH']
  ]) {
    const result = checkRules({ rules: [rule()], exceptions: [{ ...exception(version()), ...patch }], stage: 'foundation' }, context())
    assert.ok(errors(result).includes(code))
    assert.equal(result.exceptions[0].valid, false)
  }
})

test('required empty selection fails and optional empty selection is visibly not selected', () => {
  const required = checkRules({ rules: [{ ...rule(), from: [] }] }, context())
  assert.deepEqual(errors(required), ['EMPTY_RULE_SELECTION'])
  assert.equal(required.ruleChecks[0].status, 'failed')
  const optional = checkRules({ rules: [{ ...rule(), to: [], required: false }] }, context())
  assert.deepEqual(errors(optional), [])
  assert.equal(optional.ruleChecks[0].status, 'not-selected')
  assert.ok(optional.diagnostics.some(item => item.code === 'EMPTY_RULE_SELECTION' && item.severity === 'warning'))
})

test('retired candidates and absent governing evidence cannot satisfy rules', () => {
  const selected = context()
  selected.candidateIds.delete('documents')
  assert.ok(errors(checkRules({ rules: [rule()] }, selected)).includes('RULE_SOURCE_UNAVAILABLE'))
  for (const resolve of [() => null, () => ({ ...evidence, sha256: 'short' }), () => { throw new Error('Missing source') }]) {
    const result = checkRules({ rules: [rule()] }, { ...context(), resolve })
    assert.deepEqual(errors(result), ['RULE_GOVERNING_UNRESOLVED'])
    assert.equal(result.ruleChecks[0].version, null)
    assert.notEqual(result.ruleChecks[0].status, 'passed')
  }
})

test('exception expiry and stage checks use explicit deterministic inputs', () => {
  const record = { ...exception(version()), expires: '2026-10-23' }
  const run = (patch = {}, change = {}) => checkRules({ rules: [rule()], exceptions: [{ ...record, ...change }], stage: 'foundation', asOf: '2026-10-23', ...patch }, context())
  assert.deepEqual(errors(run()), [])
  assert.ok(errors(run({ asOf: '2026-10-24' })).includes('EXCEPTION_EXPIRED'))
  assert.ok(errors(run({ asOf: undefined })).includes('EXCEPTION_DATE_UNRESOLVED'))
  assert.ok(errors(run({ stage: 'later' })).includes('EXCEPTION_STAGE_MISMATCH'))
  assert.ok(errors(run({ stage: undefined })).includes('EXCEPTION_STAGE_MISMATCH'))
  assert.ok(errors(run({}, { expires: '2026-02-30' })).includes('INVALID_EXCEPTION'))
  assert.ok(errors(run({ asOf: '2026-02-30' })).includes('INVALID_AS_OF'))
})

test('strict schemas reject extra fields, duplicate rules and incomplete exception decisions', () => {
  assert.ok(errors(checkRules({ rules: [{ ...rule(), command: 'echo unsafe' }] }, context())).includes('INVALID_RULE'))
  const duplicate = checkRules({ rules: [rule(), rule()] }, context())
  assert.ok(errors(duplicate).includes('DUPLICATE_RULE_ID'))
  assert.ok(duplicate.ruleChecks.every(item => item.status !== 'passed'))
  for (const patch of [{ decision: '' }, { owner: ' ' }, { scope: [] }, { revisit: undefined }, { approved: true }]) {
    const result = checkRules({ rules: [rule()], exceptions: [{ ...exception(version()), ...patch }], stage: 'foundation' }, context())
    assert.ok(errors(result).includes('INVALID_EXCEPTION'))
    assert.equal(result.exceptions[0].valid, false)
  }
})

test('only the selected declared relation type is checked and input remains unchanged', () => {
  const input = { rules: [rule()] }
  const before = JSON.stringify(input)
  const result = checkRules(input, context([{ type: 'normative', from: 'model', to: 'documents' }, { type: 'implementation', from: 'other', to: 'documents' }]))
  assert.deepEqual(errors(result), [])
  assert.equal(result.ruleChecks[0].status, 'passed')
  assert.equal(JSON.stringify(input), before)
})

test('no configured rules is valid, but malformed or oversized collections are not', () => {
  assert.deepEqual(checkRules({}, context()), { diagnostics: [], ruleChecks: [], exceptions: [] })
  assert.ok(errors(checkRules({ rules: {} }, context())).includes('INVALID_RULE_COLLECTION'))
  assert.ok(errors(checkRules({ rules: Array.from({ length: 65 }, rule) }, context())).includes('INVALID_RULE_COLLECTION'))
  assert.ok(errors(checkRules(null, context())).includes('INVALID_RULE_INPUT'))
})
