'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { parseSpecRelations } = require('./spec-relations')

test('legacy declarations and blank template fields remain supported', () => {
  for (const value of [undefined, null, '', '   ', []]) {
    assert.deepEqual(parseSpecRelations({ supersedes: null, 'depends-on': value }, 'example/specs', 'self'), { supersedes: null, dependsOn: [], issues: [] })
  }
  for (const value of [[12, '#7', 'other/specs#3'], '12, #7, other/specs#3']) {
    const parsed = parseSpecRelations({ 'depends-on': value, supersedes: 'old-note' }, 'example/specs', 'self')
    assert.deepEqual(parsed.dependsOn, [{ ns: 'example/specs', n: 12 }, { ns: 'example/specs', n: 7 }, { ns: 'other/specs', n: 3 }])
    assert.deepEqual(parsed.supersedes, { noteId: 'old-note' })
    assert.deepEqual(parsed.issues, [])
  }
  assert.deepEqual(parseSpecRelations({ 'depends-on': 12, supersedes: 3 }, 'example/specs').dependsOn, [{ ns: 'example/specs', n: 12 }])
})

test('invalid values remain diagnostics instead of plausible references', () => {
  const invalid = [0, -1, '-2', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 'other/specs#9007199254740993', 'other/specs##3', {}, [], false, null, '', 'a b']
  const parsed = parseSpecRelations({ supersedes: [3], 'depends-on': [...invalid, 4] }, 'example/specs')
  assert.deepEqual(parsed.dependsOn, [{ ns: 'example/specs', n: 4 }])
  assert.equal(parsed.supersedes, null)
  assert.equal(parsed.issues.length, invalid.length + 1)
  assert.ok(parsed.issues.every(issue => issue.code === 'INVALID_REFERENCE' && issue.severity === 'error'))
  assert.equal(parsed.issues.at(-1).index, invalid.length - 1)
})

test('self references and duplicate aliases are identified while normalizing edges', () => {
  const parsed = parseSpecRelations({ supersedes: 'self', 'depends-on': ['self', 7, '#7', 'example/specs#7', 12, '#12'] }, 'example/specs', 'self', { selfNumber: 7 })
  assert.equal(parsed.supersedes, null)
  assert.deepEqual(parsed.dependsOn, [{ ns: 'example/specs', n: 12 }])
  assert.equal(parsed.issues.filter(issue => issue.code === 'SELF_REFERENCE').length, 5)
  assert.equal(parsed.issues.filter(issue => issue.code === 'DUPLICATE_REFERENCE').length, 1)
})

test('unquoted numeric hash references identify the source field and line', () => {
  const content = '---\ntags: [spec]\nnamespace: example/specs\nsupersedes: #12\ndepends-on: #7\n---\nBody'
  const parsed = parseSpecRelations({ supersedes: null, 'depends-on': null }, 'example/specs', 'self', { content, start: 0, end: content.indexOf('\n---', 3) })
  assert.deepEqual(parsed.issues.map(issue => [issue.code, issue.field, issue.line]), [
    ['REFERENCE_COMMENTED_OUT', 'supersedes', 4], ['REFERENCE_COMMENTED_OUT', 'depends-on', 5]
  ])
  const block = '---\ndescription: |\n  supersedes: #12\nsupersedes:\ndepends-on:\n---\nBody'
  assert.deepEqual(parseSpecRelations({ description: 'supersedes: #12', supersedes: null, 'depends-on': null }, 'example/specs', 'self', {
    content: block, start: 0, end: block.indexOf('\n---', 3)
  }).issues, [])
})

test('cross-project dependencies remain valid but cannot authorize retirement', () => {
  const parsed = parseSpecRelations({ supersedes: 'other/specs#3', 'depends-on': ['other/specs#3'] }, 'example/specs')
  assert.equal(parsed.supersedes, null)
  assert.deepEqual(parsed.dependsOn, [{ ns: 'other/specs', n: 3 }])
  assert.ok(parsed.issues.some(issue => issue.code === 'CROSS_NAMESPACE_SUPERSESSION' && issue.severity === 'error'))
})

test('oversized relation collections are bounded and cannot pass silently', () => {
  const parsed = parseSpecRelations({ 'depends-on': Array.from({ length: 513 }, (_, index) => index + 1) }, 'example/specs')
  assert.equal(parsed.dependsOn.length, 512)
  assert.ok(parsed.issues.some(issue => issue.code === 'TOO_MANY_RELATIONS'))
})
