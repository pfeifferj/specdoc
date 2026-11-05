'use strict'

const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { inspectAudit, runAudit } = require('./check-editor-audit.cjs')

function advisory (overrides = {}) {
  return {
    value: 'babel-traverse',
    children: {
      ID: 1117412,
      URL: 'https://github.com/advisories/GHSA-67hx-6x53-jw92',
      Severity: 'critical',
      'Tree Versions': ['6.26.0'],
      Dependents: ['babel-core@npm:6.26.3'],
      ...overrides
    }
  }
}

function result (rows, status = 1) {
  return { stdout: rows.map(row => JSON.stringify(row)).join('\n'), stderr: '', status, signal: null }
}

test('audit command includes browser and transitive dependencies without severity or environment filters', () => {
  let invocation
  runAudit((...args) => { invocation = args; return {} }, { ...process.env, YARN_NPM_AUDIT_IGNORE_ADVISORIES: '*' })
  assert.equal(invocation[2].env.YARN_NPM_AUDIT_IGNORE_ADVISORIES, undefined)
  assert.equal(invocation[2].env.YARN_IGNORE_PATH, '1')
  assert.equal(invocation[0], process.execPath)
  assert.deepEqual(invocation[1], [resolve('.yarn/releases/yarn-4.13.0.cjs'), 'npm', 'audit', '--all', '--recursive', '--json'])
  assert.equal(invocation[2].shell, undefined)
  assert.ok(invocation[2].timeout > 0)
})

test('only exact reviewed build advisories receive an exception', () => {
  assert.equal(inspectAudit(result([advisory()])).exceptions.length, 1)
  for (const row of [
    { ...advisory(), value: 'browser-library' },
    advisory({ URL: 'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx' }),
    advisory({ 'Tree Versions': ['6.26.0', '7.0.0'] }),
    advisory({ Dependents: ['babel-core@npm:6.26.3', 'HedgeDoc@workspace:.'] })
  ]) {
    assert.equal(inspectAudit(result([row])).failures.length, 1)
  }
})

test('virtual dependency locators retain exact reviewed parent package and version', () => {
  const row = {
    value: 'browserslist',
    children: advisory({
      URL: 'https://github.com/advisories/GHSA-c83g-rgw3-j3cx', Severity: 'high',
      'Tree Versions': ['3.2.8'], Dependents: ['babel-preset-env@virtual:abc123#npm:1.7.0']
    }).children
  }
  assert.equal(inspectAudit(result([row])).exceptions.length, 1)
  row.children.Dependents.push('other-consumer@virtual:abc123#npm:5.1.0')
  assert.equal(inspectAudit(result([row])).failures.length, 1)
})

test('deprecations are counted separately and moderate advisories are not concealed', () => {
  const report = inspectAudit(result([
    { value: 'legacy-package', children: { ID: 'legacy-package (deprecation)', Severity: 'high' } },
    advisory({ Severity: 'moderate' })
  ]))
  assert.equal(report.deprecations, 1)
  assert.equal(report.advisories, 1)
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.exceptions, [])
})

test('a clean successful audit may be empty', () => {
  assert.equal(inspectAudit(result([], 0)).advisories, 0)
})

test('registry failures, malformed responses and incomplete subprocesses fail closed', () => {
  const valid = result([advisory()])
  for (const response of [
    result([], 1),
    result([{ type: 'error', data: 'registry request failed' }]),
    { ...valid, stdout: '{partial' },
    { ...valid, stderr: 'registry request failed' },
    { ...valid, error: new Error('spawn ENOENT') },
    { ...valid, status: null, signal: 'SIGTERM' },
    { ...valid, status: 2 },
    result([advisory({ Severity: 'unknown' })]),
    result([advisory({ ID: 'babel-traverse (deprecation)' })]),
    result([advisory({ Dependents: [] })])
  ]) assert.throws(() => inspectAudit(response), /Yarn audit/)
})
