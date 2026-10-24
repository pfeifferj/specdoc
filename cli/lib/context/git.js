'use strict'
const { execFileSync } = require('node:child_process')
const { gitScope } = require('./access')

function readGit (repo, args, { encoding = 'utf8', maxBuffer = 1 << 26, stderr = 'ignore' } = {}) {
  const scope = gitScope(repo)
  repo = scope.repo
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_NO_REPLACE_OBJECTS = '1'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_ATTR_NOSYSTEM = '1'
  return execFileSync('git', [...scope.args, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.excludesFile=/dev/null', '-c', 'core.attributesFile=/dev/null', ...args], {
    cwd: repo, encoding, maxBuffer, timeout: 15000, env, stdio: ['ignore', 'pipe', stderr]
  })
}

module.exports = { readGit }
