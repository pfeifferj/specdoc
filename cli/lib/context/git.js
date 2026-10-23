'use strict'
const { execFileSync } = require('node:child_process')

function readGit (repo, args, { encoding = 'utf8', maxBuffer = 1 << 26, stderr = 'ignore' } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  env.GIT_NO_REPLACE_OBJECTS = '1'
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
    cwd: repo, encoding, maxBuffer, env, stdio: ['ignore', 'pipe', stderr]
  })
}

module.exports = { readGit }
