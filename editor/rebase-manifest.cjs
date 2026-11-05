'use strict'

const fs = require('node:fs')

const sections = ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const metadata = new Set(['version', 'engines', 'packageManager'])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function checkManifest (manifest, targetVersion) {
  if (!manifest || Array.isArray(manifest) || !/^1\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version)) {
    throw new Error('The editor manifest must describe a HedgeDoc 1.x release.')
  }
  if (targetVersion && manifest.version !== targetVersion) throw new Error(`Manifest version must match target ${targetVersion}.`)
  for (const section of sections) {
    if (manifest[section] !== undefined && (!manifest[section] || typeof manifest[section] !== 'object' || Array.isArray(manifest[section]))) {
      throw new Error(`Invalid manifest section: ${section}`)
    }
    for (const [name, value] of Object.entries(manifest[section] || {})) {
      if (typeof value !== 'string') throw new Error(`Invalid ${section}.${name}`)
    }
  }
}

function matchingPatch (name, patch, target) {
  if (typeof patch !== 'string' || !patch.startsWith('patch:')) return false
  const source = decodeURIComponent(patch.slice(6).split('#')[0])
  return source === `${name}@npm:${target}`
}

function checkForkPatches (manifest, fork, target) {
  for (const section of sections.filter(name => name !== 'scripts')) {
    for (const [name, upstream] of Object.entries(target[section] || {})) {
      const previous = (fork[section] || {})[name]
      const required = upstream.startsWith('patch:')
        ? upstream
        : matchingPatch(name, previous, upstream) ? previous : null
      if (required && (manifest[section] || {})[name] !== required) {
        throw new Error(`Required dependency patch missing: ${section}.${name}`)
      }
    }
  }
}

function checkLockCommit (parsedTrailers, paths) {
  const locks = parsedTrailers.split('\n').filter(line => line.startsWith('Specdoc-Lock:'))
  if (locks.length !== 1 || !/^Specdoc-Lock: 1\.\d+\.\d+$/.test(locks[0])) {
    throw new Error('A lock commit must have one Specdoc-Lock release trailer.')
  }
  if (!paths.length || paths.some(path => !['package.json', 'yarn.lock'].includes(path))) {
    throw new Error('A lock commit may change only package.json and yarn.lock.')
  }
}

function mergeManifest (base, fork, target) {
  for (const manifest of [base, fork, target]) checkManifest(manifest)
  const result = structuredClone(target)
  const conflicts = []
  if (!same(base.engines, fork.engines) && !same(fork.engines, target.engines)) {
    if (same(base.engines, target.engines)) result.engines = structuredClone(fork.engines)
    else conflicts.push('engines: runtime requirements changed in both the fork and upstream')
  }
  for (const key of Object.keys(fork)) {
    if (!sections.includes(key) && !metadata.has(key) && !own(base, key) && !own(target, key)) result[key] = fork[key]
  }
  for (const section of sections) {
    const original = base[section] || {}
    const changed = fork[section] || {}
    const upstream = target[section] || {}
    const values = { ...upstream }
    for (const name of new Set([...Object.keys(original), ...Object.keys(changed)])) {
      const before = original[name]
      const after = changed[name]
      const current = upstream[name]
      if (same(before, after) || same(after, current)) continue
      if (!own(changed, name)) {
        if (same(before, current)) delete values[name]
        else conflicts.push(`${section}.${name}: removed in the fork but changed upstream`)
      } else if (!own(original, name) && !own(upstream, name)) {
        values[name] = after
      } else if (section === 'scripts' && same(before, current)) {
        values[name] = after
      } else if (section !== 'scripts' && matchingPatch(name, after, current)) {
        values[name] = after
      } else {
        conflicts.push(`${section}.${name}: fork ${JSON.stringify(after)}, upstream ${JSON.stringify(current)}`)
      }
    }
    if (Object.keys(values).length) result[section] = values
    else delete result[section]
  }
  for (const name of Object.keys(result.dependencies || {})) {
    if (own(result.devDependencies || {}, name) && !same(result.dependencies[name], result.devDependencies[name]) &&
        !(own(target.dependencies || {}, name) && own(target.devDependencies || {}, name))) {
      conflicts.push(`${name}: fork introduces different runtime and development versions`)
    }
  }
  if (conflicts.length) throw new Error(`Manifest needs explicit resolution:\n${conflicts.join('\n')}`)
  checkManifest(result)
  return result
}

function dropLockCommits (todo, locks) {
  const seen = new Set()
  const lines = todo.split('\n').map(line => {
    const match = /^pick ([0-9a-f]+)(\s.*)?$/.exec(line)
    if (!match) return line
    const candidates = locks.filter(hash => hash.startsWith(match[1]))
    if (candidates.length > 1) throw new Error(`Ambiguous lock commit: ${match[1]}`)
    if (!candidates.length) return line
    if (seen.has(candidates[0])) throw new Error(`Repeated lock commit: ${match[1]}`)
    seen.add(candidates[0])
    return line.replace(/^pick /, 'drop ')
  })
  for (const hash of locks) if (!seen.has(hash)) throw new Error(`Lock commit missing from replay: ${hash}`)
  return lines.join('\n')
}

module.exports = { checkManifest, checkForkPatches, checkLockCommit, mergeManifest, dropLockCommits }
if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--check' && args.length >= 2 && args.length <= 4) {
      const manifest = JSON.parse(fs.readFileSync(args[1], 'utf8'))
      const target = args[2] && JSON.parse(fs.readFileSync(args[2], 'utf8'))
      checkManifest(manifest, target && target.version)
      if (args[3]) checkForkPatches(manifest, JSON.parse(fs.readFileSync(args[3], 'utf8')), target)
    } else if (args[0] === '--check-lock' && args.length === 3) {
      checkLockCommit(fs.readFileSync(args[1], 'utf8'), fs.readFileSync(args[2], 'utf8').split('\n').filter(Boolean))
    } else if (args[0] === '--drop-locks' && args.length === 3) {
      const locks = fs.readFileSync(args[1], 'utf8').split(/\s+/).filter(Boolean)
      const todo = fs.readFileSync(args[2], 'utf8')
      fs.writeFileSync(args[2], dropLockCommits(todo, locks))
    } else if (args.length === 4) {
      const manifests = args.slice(0, 3).map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
      fs.writeFileSync(args[3], JSON.stringify(mergeManifest(...manifests), null, 2) + '\n')
    } else throw new Error('Usage: rebase-manifest.cjs BASE FORK TARGET OUTPUT')
  } catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
