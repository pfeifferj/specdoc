'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')
const { OperationError } = require('../errors')

const access = new AsyncLocalStorage()
const denied = message => new OperationError('ACCESS_DENIED', message)
const within = (root, file) => file === root || file.startsWith(root + path.sep)

function createAccessPolicy (roots) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 32) throw denied('Configure one to 32 allowed local roots')
  const allowed = [...new Set(roots.map(root => {
    if (typeof root !== 'string' || !root || root.length > 4096) throw denied('Allowed roots must be directory paths')
    const real = fs.realpathSync(root)
    if (!fs.statSync(real).isDirectory() || real === path.parse(real).root) throw denied('An allowed root must be a specific directory')
    return real
  }))]
  return Object.freeze({ roots: Object.freeze(allowed) })
}

function withAccess (policy, work) { return access.run(policy, work) }

function assertPath (file) {
  const resolved = path.resolve(file)
  const policy = access.getStore()
  if (policy && !policy.roots.some(root => within(root, resolved))) throw denied('Path is outside the configured local roots')
  const real = fs.realpathSync(resolved)
  if (real !== resolved) throw denied('Local sources cannot contain symlink components')
  if (policy && !policy.roots.some(root => within(root, real))) throw denied('Resolved path is outside the configured local roots')
  return real
}

function readRegular (file, limit = 4 * 1024 * 1024) {
  const resolved = assertPath(file)
  const before = fs.lstatSync(resolved)
  if (!before.isFile() || before.size > limit) throw denied(`Source must be a regular file of at most ${limit} bytes`)
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) throw denied('Source changed while it was opened')
    assertPath(resolved)
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > limit) throw denied(`Source exceeds ${limit} bytes`)
    const after = fs.lstatSync(resolved)
    if (after.dev !== opened.dev || after.ino !== opened.ino || assertPath(resolved) !== resolved) throw denied('Source changed while it was read')
    return bytes.subarray(0, length)
  } finally { fs.closeSync(fd) }
}

function gitScope (repo) {
  if (!access.getStore()) return { repo, args: [] }
  const root = assertPath(repo)
  if (!fs.statSync(root).isDirectory()) throw denied('Repository must be a directory')
  let cursor = root, marker
  for (;;) {
    marker = path.join(cursor, '.git')
    if (fs.existsSync(marker)) break
    const parent = path.dirname(cursor)
    if (parent === cursor) throw denied('Repository has no local Git metadata')
    assertPath(parent)
    cursor = parent
  }
  assertPath(marker)
  let gitDir = marker
  if (fs.lstatSync(marker).isFile()) {
    const pointer = /^gitdir: ([^\r\n\0]+)\s*$/.exec(readRegular(marker, 8192).toString('utf8'))
    if (!pointer) throw denied('Invalid Git worktree metadata')
    gitDir = assertPath(path.resolve(cursor, pointer[1]))
  }
  const directories = [gitDir]
  const commonFile = path.join(gitDir, 'commondir')
  if (fs.existsSync(commonFile)) {
    const common = readRegular(commonFile, 8192).toString('utf8').trim()
    if (!common || /[\r\n\0]/.test(common)) throw denied('Invalid Git common directory')
    directories.push(assertPath(path.resolve(gitDir, common)))
  }
  const seen = new Set(), pending = [...new Set(directories)]
  while (pending.length) {
    const current = pending.pop()
    if (seen.has(current)) continue
    if (seen.size >= 100000) throw denied('Git metadata exceeds the local inspection limit')
    seen.add(current)
    assertPath(current)
    const st = fs.lstatSync(current)
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name))
    } else if (!st.isFile()) throw denied('Git metadata must contain only regular files and directories')
  }
  for (const directory of new Set(directories)) {
    for (const name of ['config', 'config.worktree']) {
      const file = path.join(directory, name)
      if (fs.existsSync(file)) {
        const config = readRegular(file, 256 * 1024).toString('utf8')
        if (/^\s*\[\s*include(?:if)?(?:\s|\.|\])/im.test(config)) throw denied('Git configuration includes are not permitted by the local access policy')
        if (/^\s*\[\s*filter(?:\s|\.|\])/im.test(config)) throw denied('Git filters are not permitted by the local access policy')
      }
    }
    const alternates = path.join(directory, 'objects', 'info', 'alternates')
    if (fs.existsSync(alternates) && readRegular(alternates, 8192).toString('utf8').trim()) {
      throw denied('Git object alternates require a self-contained checkout for MCP')
    }
    const httpAlternates = path.join(directory, 'objects', 'info', 'http-alternates')
    if (fs.existsSync(httpAlternates) && readRegular(httpAlternates, 8192).toString('utf8').trim()) {
      throw denied('Remote Git object alternates are not permitted')
    }
  }
  return { repo: root, args: [`--git-dir=${gitDir}`, `--work-tree=${cursor}`] }
}

const assertRepository = repo => gitScope(repo).repo

module.exports = { createAccessPolicy, withAccess, assertPath, assertRepository, gitScope, readRegular }
