#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

// These exceptions cover only the build paths reviewed in docs/dependency-security.md.
const buildAdvisories = [
  {
    name: 'babel-traverse',
    url: 'https://github.com/advisories/GHSA-67hx-6x53-jw92',
    versions: ['6.26.0'],
    dependents: ['babel-core@npm:6.26.3'],
    reason: 'Babel compiles checkout source in an isolated build; compiler migration remains required.'
  },
  {
    name: 'browserslist',
    url: 'https://github.com/advisories/GHSA-c83g-rgw3-j3cx',
    versions: ['3.2.8'],
    dependents: ['babel-preset-env@npm:1.7.0'],
    reason: 'The legacy Babel preset consumes repository build queries, not note content.'
  },
  {
    name: 'browserslist',
    url: 'https://github.com/advisories/GHSA-73wf-gq98-2v4g',
    versions: ['3.2.8'],
    dependents: ['babel-preset-env@npm:1.7.0'],
    reason: 'Custom browser statistics come from reviewed build configuration.'
  }
]

function normalizedLocator (value) {
  return value.replace(/@virtual:[a-f0-9]+#npm:/, '@npm:')
}

function inspectAudit (result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Yarn audit did not complete (status ${result.status}, signal ${result.signal || 'none'}).`)
  }
  if (result.stderr && result.stderr.trim()) throw new Error('Yarn audit wrote unexpected diagnostics to stderr.')
  const lines = (result.stdout || '').split(/\r?\n/).filter(line => line.trim())
  if (result.status === 1 && !lines.length) throw new Error('Yarn audit failed without a report.')
  const report = { advisories: 0, deprecations: 0, exceptions: [], failures: [] }
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { throw new Error('Yarn audit returned invalid JSON.') }
    const item = row.children
    if (typeof row.value !== 'string' || !row.value || !item || typeof item !== 'object') {
      throw new Error('Yarn audit returned an unexpected record; registry errors cannot be ignored.')
    }
    if (item.ID === `${row.value} (deprecation)` && item.URL === undefined) {
      report.deprecations++
      continue
    }
    if (!Number.isInteger(item.ID) || item.ID <= 0 ||
        typeof item.URL !== 'string' || !/^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(item.URL) ||
        !['info', 'low', 'moderate', 'high', 'critical'].includes(item.Severity) ||
        !Array.isArray(item['Tree Versions']) || !item['Tree Versions'].length ||
        !item['Tree Versions'].every(value => typeof value === 'string' && value) ||
        !Array.isArray(item.Dependents) || !item.Dependents.length ||
        !item.Dependents.every(value => typeof value === 'string' && value)) {
      throw new Error('Yarn audit returned an unsupported advisory record.')
    }
    report.advisories++
    if (!['high', 'critical'].includes(item.Severity)) continue
    const exception = buildAdvisories.find(entry => entry.name === row.value && entry.url === item.URL &&
      item['Tree Versions'].every(value => entry.versions.includes(value)) &&
      item.Dependents.every(value => entry.dependents.includes(normalizedLocator(value))))
    if (exception) report.exceptions.push(exception)
    else report.failures.push({ name: row.value, severity: item.Severity, url: item.URL })
  }
  return report
}

function runAudit (spawn = spawnSync) {
  const yarnCli = resolve('.yarn/releases/yarn-4.13.0.cjs')
  return spawn(process.execPath, [yarnCli, 'npm', 'audit', '--all', '--recursive', '--json'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', FORCE_COLOR: '0' }
  })
}

if (require.main === module) {
  try {
    const report = inspectAudit(runAudit())
    console.log(`Editor full-tree audit: ${report.advisories} advisories, ${report.deprecations} separate deprecation notices.`)
    for (const entry of report.exceptions) console.log(`Reviewed build exception: ${entry.name} ${entry.url} — ${entry.reason}`)
    for (const entry of report.failures) console.error(`Blocked ${entry.severity} advisory: ${entry.name} ${entry.url}`)
    if (report.failures.length) process.exitCode = 1
  } catch (error) {
    console.error(`Editor dependency audit failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { inspectAudit, runAudit }
