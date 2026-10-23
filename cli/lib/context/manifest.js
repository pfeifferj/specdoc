'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { readGit } = require('./git')
const { createHash } = require('node:crypto')
const { OperationError } = require('../errors')
const { Specs } = require('./specs')
const { sections } = require('./sections')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const invalid = message => new OperationError('INVALID_MANIFEST', message)
const fullRevision = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || '')
const namespace = value => /^[\w.-]+\/[\w.-]+$/.test(value || '')
const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
const relativePath = value => typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && !value.split('/').includes('..')
const git = (repo, ...args) => {
  try { return readGit(repo, args, { encoding: null, maxBuffer: 4 * 1024 * 1024, stderr: 'pipe' }) } catch (e) {
    throw invalid(`Cannot read configured Git source ${repo}: ${e.stderr?.toString().trim() || e.message}`)
  }
}
const revision = (repo, ref) => {
  if (!bounded(ref, 2048) || /[\x00-\x20]/.test(ref)) throw invalid('Every repository needs an explicit Git revision or ref of at most 2048 characters')
  const commit = git(repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim()
  if (!fullRevision(commit)) throw invalid('Git did not resolve a full commit revision')
  return commit
}
function readSource (source) {
  const blob = git(source.repository, 'rev-parse', '--verify', '--end-of-options', `${source.revision}:${source.path}`).toString().trim()
  if (!fullRevision(blob) || git(source.repository, 'cat-file', '-t', blob).toString().trim() !== 'blob') throw invalid(`Source ${source.id} is not a Git blob`)
  const bytes = git(source.repository, 'cat-file', 'blob', blob)
  let body
  try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw invalid(`Source ${source.id} must be valid UTF-8`) }
  if (body.includes('\0')) throw invalid(`Source ${source.id} cannot contain NUL`)
  return { blob, sha256: sha256(bytes), body }
}
const manifestId = manifest => {
  const { id, ...content } = manifest
  return sha256(JSON.stringify(content))
}
function gapsFor (manifest) {
  const gaps = []
  const add = (code, message, sourceId) => gaps.push({ code, message, ...(sourceId ? { sourceId } : {}) })
  if (manifest.selection?.requirementsComplete !== true) add('REQUIREMENTS_SELECTION_UNCONFIRMED', 'Caller has not confirmed the governing requirement selection is complete')
  if (manifest.selection?.dependenciesComplete !== true) add('DEPENDENCY_SELECTION_UNCONFIRMED', 'Caller has not confirmed the declared dependency selection is complete')
  if (!manifest.sources.some(s => s.role === 'governing')) add('NO_GOVERNING_SOURCE', 'Manifest has no governing requirements source')
  const ids = new Set(manifest.sources.map(s => s.id))
  for (const s of manifest.sources) {
    if (s.role === 'governing' && s.authority !== 'caller-selected-merged') add('UNVERIFIED_AUTHORITY', `Governing source ${s.id} has no caller-selected merged baseline`, s.id)
    for (const dependency of s.dependencies) {
      if (!ids.has(dependency)) add('MISSING_DEPENDENCY', `Unresolved dependency ${dependency} from ${s.id}`, s.id)
    }
  }
  for (const gap of manifest.declaredGaps || []) add('CALLER_DECLARED_GAP', gap)
  return gaps
}
function sourceShape (source) {
  if (!source || !bounded(source.id, 128) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(source.id) || !bounded(source.namespace, 256) || !namespace(source.namespace) || !bounded(source.path, 4096) || !relativePath(source.path)) throw invalid('Each source needs a stable id, explicit owner/repository namespace and relative Git path within metadata limits')
  if (!['governing', 'supporting'].includes(source.role) || !['caller-selected-merged', 'unverified'].includes(source.authority)) throw invalid(`Source ${source.id} needs an explicit role and authority`)
  if (source.selectedRef !== undefined && !bounded(source.selectedRef, 2048)) throw invalid(`Source ${source.id} selected ref exceeds metadata limits`)
  if (source.reference !== undefined) {
    const number = typeof source.reference === 'string' && source.reference.startsWith(`${source.namespace}#`) ? source.reference.slice(source.namespace.length + 1) : ''
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw invalid(`Source ${source.id} reference must explicitly name its namespace and safe positive issue number`)
  }
  if (!Array.isArray(source.dependencies) || source.dependencies.length > 128 || source.dependencies.some(d => !bounded(d, 128) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(d))) throw invalid(`Source ${source.id} dependencies must contain at most 128 stable source ids`)
  if (!Array.isArray(source.requirements) || source.requirements.length > 64) throw invalid(`Source ${source.id} requirements must contain at most 64 mappings`)
  const requirementIds = new Set()
  for (const r of source.requirements) {
    if (!r || !bounded(r.id, 128) || !r.id.trim() || requirementIds.has(r.id) || !Array.isArray(r.sections) || !r.sections.length || r.sections.length > 64) throw invalid(`Source ${source.id} has an invalid or duplicate requirement mapping (at most 64 sections per mapping)`)
    requirementIds.add(r.id)
  }
}
function createManifest (config, base = process.cwd()) {
  if (!config || config.schemaVersion !== 1 || !config.implementation || !Array.isArray(config.sources) || config.sources.length > 128) throw invalid('Expected schemaVersion 1, implementation and at most 128 configured sources')
  const resolveRepo = repo => {
    if (!bounded(repo, 4096)) throw invalid('A configured local Git repository path is required (at most 4096 characters)')
    try { return fs.realpathSync(path.resolve(base, repo)) } catch { throw invalid(`Configured repository does not exist: ${repo}`) }
  }
  const implRepo = resolveRepo(config.implementation.repository)
  const revisions = new Map()
  const resolveRevision = (repo, ref) => {
    const key = JSON.stringify([repo, ref])
    if (!revisions.has(key)) revisions.set(key, revision(repo, ref))
    return revisions.get(key)
  }
  const implementationRevision = resolveRevision(implRepo, config.implementation.revision)
  const scope = config.implementation.scope
  if (!Array.isArray(scope) || !scope.length || scope.length > 128 || scope.some(p => !bounded(p, 4096) || !relativePath(p))) throw invalid('Implementation scope must name at most 128 relative owned paths (use . for the whole repository)')
  const sources = config.sources.map(s => {
    sourceShape(s)
    const repository = resolveRepo(s.repository)
    const source = { id: s.id, namespace: s.namespace, repository, revision: resolveRevision(repository, s.revision), path: s.path,
      ...(s.reference ? { reference: s.reference } : {}), role: s.role, authority: s.authority,
      selectedRef: s.revision, dependencies: [...s.dependencies], requirements: s.requirements }
    const { blob, sha256: hash, body } = readSource(source)
    const parsed = sections(body)
    const requirements = s.requirements.map(r => ({ id: r.id, sections: r.sections.map(selector => {
      const matches = parsed.filter(section => Number.isSafeInteger(selector) ? section.number === selector : section.label === selector)
      if (matches.length !== 1) throw invalid(`Source ${s.id} requirement ${r.id} section selector ${selector} must match exactly one section`)
      return matches[0].number
    }) }))
    return { ...source, requirements, blob, sha256: hash }
  })
  if (new Set(sources.map(s => s.id)).size !== sources.length || new Set(sources.filter(s => s.reference).map(s => s.reference)).size !== sources.filter(s => s.reference).length) throw invalid('Source ids and explicit references must be unique')
  const manifest = { schemaVersion: 1, kind: 'specdoc-task-context', createdAt: new Date().toISOString(),
    ...(typeof config.task === 'string' ? { task: config.task } : {}),
    implementation: { repository: implRepo, revision: implementationRevision, scope: [...scope] },
    selection: { requirementsComplete: config.selection?.requirementsComplete === true, dependenciesComplete: config.selection?.dependenciesComplete === true },
    declaredGaps: config.declaredGaps || [], sources }
  if (!Array.isArray(manifest.declaredGaps) || manifest.declaredGaps.length > 128 || manifest.declaredGaps.some(g => !bounded(g, 2048) || !g.trim())) throw invalid('declaredGaps must contain at most 128 nonempty messages of at most 2048 characters')
  manifest.requiredGaps = gapsFor(manifest)
  manifest.id = manifestId(manifest)
  return manifest
}
function loadManifest (file) {
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw invalid(`Cannot read manifest: ${e.message}`) }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'specdoc-task-context' || !/^[a-f0-9]{64}$/.test(manifest.id || '') || manifestId(manifest) !== manifest.id || !Array.isArray(manifest.sources) || manifest.sources.length > 128) throw invalid('Manifest identity, schema or source list is invalid; create a new manifest from configuration')
  if (!manifest.implementation || !bounded(manifest.implementation.repository, 4096) || !path.isAbsolute(manifest.implementation.repository) || !fullRevision(manifest.implementation.revision) || !Array.isArray(manifest.implementation.scope) || !manifest.implementation.scope.length || manifest.implementation.scope.length > 128 || manifest.implementation.scope.some(p => !bounded(p, 4096) || !relativePath(p))) throw invalid('Manifest implementation base or scope is invalid')
  if (revision(manifest.implementation.repository, manifest.implementation.revision) !== manifest.implementation.revision) throw invalid('Implementation base revision is unavailable')
  if (new Set(manifest.sources.map(s => s?.id)).size !== manifest.sources.length || new Set(manifest.sources.filter(s => s?.reference).map(s => s.reference)).size !== manifest.sources.filter(s => s?.reference).length) throw invalid('Manifest source ids and explicit references must be unique')
  if (!Array.isArray(manifest.declaredGaps) || manifest.declaredGaps.length > 128 || manifest.declaredGaps.some(g => !bounded(g, 2048) || !g.trim())) throw invalid('Manifest declaredGaps exceeds metadata limits')
  for (const source of manifest.sources) {
    sourceShape(source)
    if (!bounded(source.repository, 4096) || !path.isAbsolute(source.repository) || !fullRevision(source.revision) || !fullRevision(source.blob) || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw invalid(`Source ${source.id} lacks a pinned repository, revision, blob or SHA-256`)
    const actual = readSource(source)
    if (actual.blob !== source.blob || actual.sha256 !== source.sha256) throw invalid(`Source ${source.id} hash mismatch; pinned bytes cannot be replaced`)
    const numbers = new Set(sections(actual.body).map(s => s.number))
    if (source.requirements.some(r => r.sections.some(n => !Number.isSafeInteger(n) || !numbers.has(n)))) throw invalid(`Source ${source.id} has an invalid pinned section mapping`)
  }
  const gaps = gapsFor(manifest)
  if (JSON.stringify(gaps) !== JSON.stringify(manifest.requiredGaps)) throw invalid('Manifest completeness declarations changed; create a new manifest')
  return manifest
}

class ManifestSpecs extends Specs {
  constructor (manifest) {
    super(`manifest:${manifest.id}`, [...new Set(manifest.sources.map(s => s.namespace))], true)
    this.manifest = manifest
    this.requiredGaps = manifest.requiredGaps
    this.all = manifest.sources.map(source => ({ id: source.id, namespace: source.namespace, title: source.path,
      status: 'pinned', kind: 'feature', abstract: '', dependsOn: source.dependencies, supersedes: null, superseded: false,
      pr: source.reference ? Number(source.reference.split('#')[1]) : null, specPath: source.path, url: '', pinned: source,
      requiredSections: source.role === 'governing' ? [...new Set(source.requirements.flatMap(r => r.sections))] : [] }))
    this.select()
  }

  async load () { return this }
  async document (s, { maxBytes = 256 * 1024 } = {}) {
    const actual = readSource(s.pinned)
    if (actual.blob !== s.pinned.blob || actual.sha256 !== s.pinned.sha256) throw invalid(`Source ${s.id} hash mismatch`)
    const bytes = Buffer.byteLength(actual.body)
    if (bytes > maxBytes) throw new Error(`Source ${s.id} exceeds ${maxBytes} bytes`)
    return { ...s, body: actual.body, bytes }
  }
  async body (s) { return (await this.document(s, { maxBytes: 4 * 1024 * 1024 })).body }
}

module.exports = { createManifest, loadManifest, ManifestSpecs, manifestId }
