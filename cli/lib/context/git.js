'use strict'
const { execFileSync } = require('node:child_process')
const { gitScope, gitEnv } = require('./access')

function readGit (repo, args, { encoding = 'utf8', maxBuffer = 1 << 26, stderr = 'ignore' } = {}) {
  const scope = gitScope(repo)
  repo = scope.repo
  const env = gitEnv()
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_NO_REPLACE_OBJECTS = '1'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_ATTR_NOSYSTEM = '1'
  return execFileSync('git', [...scope.args, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'log.showSignature=false', ...args], {
    cwd: repo, encoding, maxBuffer, timeout: 15000, env, stdio: ['ignore', 'pipe', stderr]
  })
}

// Recursing runs git inside nested repositories whose configuration gitScope
// never inspects; only this flag outranks a per-submodule ignore setting.
const STATUS = ['status', '--porcelain=v2', '--untracked-files=no', '--ignore-submodules=all']

function worktreeState (repo) {
  const records = readGit(repo, [...STATUS, '--branch', '-z']).split('\0').filter(Boolean)
  const oid = (records.find(record => record.startsWith('# branch.oid ')) || '').slice('# branch.oid '.length)
  const submodules = [...new Set(readGit(repo, ['ls-files', '--stage', '-z']).split('\0')
    .map(record => /^160000 [a-f0-9]+ [0-3]\t([\s\S]*)$/.exec(record)?.[1]).filter(Boolean))]
  let dirty = records.some(record => !record.startsWith('#'))
  if (!dirty) {
    const staged = readGit(repo, ['diff', '--cached', '--raw', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'])
    dirty = staged ? true : submodules.length ? null : false
  }
  return { head: oid && !oid.startsWith('(') ? oid : null, dirty, submodules }
}

const stateSuffix = dirty => dirty === null ? '+status-unknown' : dirty ? '+dirty' : ''

module.exports = { readGit, worktreeState, stateSuffix }
