'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { z } = require('zod')
const MarkdownIt = require('markdown-it')
const YAML = require('js-yaml')
const { createTwoFilesPatch } = require('diff')
const { readGit } = require('./git')
const { readRegular } = require('./access')
const { sections } = require('./sections')
const { OperationError, usage } = require('../errors')

const MAX_BYTES = 256 * 1024
const MAX_CONFIG_BYTES = 512 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const md = new MarkdownIt({ html: true })
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
const say = z.string().trim().min(1).max(2048)
const selectorSchema = z.union([
  z.object({ label: z.string().regex(/^(?:FR|SC)-\d+$/) }).strict(),
  z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict()
])
const refSchema = z.object({ source: id, selector: selectorSchema }).strict()
const gitSchema = z.object({ repository: z.string().min(1).max(4096), revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  path: z.string().min(1).max(4096), currentRef: z.string().min(1).max(2048).optional() }).strict()
const candidateSchema = z.union([gitSchema, z.object({ file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()])
const schema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('specdoc-change-bundle').optional(), title: say.optional(),
  inventory: z.object({ reviewed: z.boolean().default(false), reviewedBy: say.optional(), notes: say.optional(),
    rationale: say.optional(), status: say.optional() }).strict().default({ reviewed: false }),
  sources: z.array(z.object({ id, reference: z.string().min(1).max(256).optional(), base: gitSchema.nullable(),
    candidate: candidateSchema.nullable() }).strict()).min(1).max(32),
  obligations: z.array(z.object({ id, from: refSchema, disposition: z.enum(['retained', 'moved', 'amended', 'split', 'deferred', 'withdrawn']),
    to: z.array(refSchema).max(32).default([]), owner: say.optional(), rationale: say.optional(), revisit: say.optional() }).strict()).max(512).default([]),
  provides: z.array(z.unknown()).max(256).default([]), requires: z.array(z.unknown()).max(256).default([]),
  relations: z.array(z.unknown()).max(512).default([]), rules: z.array(z.unknown()).max(64).default([]),
  exceptions: z.array(z.unknown()).max(64).default([]), stage: say.optional(), asOf: z.string().max(64).optional()
}).strict()
const STRICT_MESSAGE = 'Change preview has unresolved structural findings; inspect diagnostics. This is not a semantic or approval verdict.'

function configError (message, details) { return new OperationError('INVALID_CHANGE_CONFIG', message, details) }
function sourceError (message) { return new OperationError('INVALID_CHANGE_SOURCE', message) }
function decode (bytes, label) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw sourceError(`${label} must be valid UTF-8`) }
  if (text.includes('\0')) throw sourceError(`${label} contains NUL`)
  return text
}
function regularFile (file, limit) {
  const resolved = path.resolve(file)
  try {
    return readRegular(resolved, limit)
  } catch (e) {
    if (e instanceof OperationError && e.code !== 'ACCESS_DENIED') throw e
    throw sourceError(`Cannot read configured file ${resolved}: ${e.message}`)
  }
}
function git (repo, ...args) {
  try { return readGit(repo, args, { encoding: null, maxBuffer: MAX_BYTES + 4096, stderr: 'pipe' }) } catch (e) {
    throw sourceError(`Cannot read configured Git object in ${repo}: ${e.stderr?.toString().trim() || e.message}`)
  }
}
function linesOf (text) {
  const starts = [0]
  for (const found of text.matchAll(/\r\n|\r|\n/g)) starts.push(found.index + found[0].length)
  const count = text.length ? starts.length - (starts.at(-1) === text.length ? 1 : 0) : 0
  return { count, slice: (start, end) => text.slice(starts[start - 1], starts[end] ?? text.length) }
}
function inventoryOf (text) {
  const lines = linesOf(text)
  const tokens = md.parse(text, {})
  const units = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== 'list_item_open' || token.level !== 1 || tokens[i + 1]?.type !== 'paragraph_open') continue
    const inline = tokens[i + 2]
    if (inline?.type !== 'inline') continue
    const content = (inline.children || []).map(t => ['softbreak', 'hardbreak'].includes(t.type) ? '\n' : t.content).join('')
    const label = /^(FR-\d+|SC-\d+)(?=\s|:|$)/.exec(content)?.[1]
    if (label) {
      if (units.length === 512) throw sourceError('Source contains more than 512 labeled obligations; split the preview input')
      units.push({ label, startLine: token.map[0] + 1, endLine: token.map[1], text: lines.slice(token.map[0] + 1, token.map[1]) })
    }
  }
  const contexts = sections(text)
  const withoutUnits = range => {
    const inside = units.filter(unit => unit.startLine >= range.start && unit.endLine <= range.end)
    let start = range.start
    const pieces = []
    for (const unit of inside) {
      if (start < unit.startLine) pieces.push(lines.slice(start, unit.startLine - 1))
      start = unit.endLine + 1
    }
    if (start <= range.end) pieces.push(lines.slice(start, range.end))
    return pieces.join('')
  }
  for (const unit of units) {
    const context = contexts.find(section => section.start <= unit.startLine && section.end >= unit.endLine)
    const scope = context ? [...context.ancestors.map(withoutUnits), ...(context.label ? [] : [withoutUnits(context)])] : []
    unit.scopeHash = hash(JSON.stringify(scope))
    unit.contentHash = hash(unit.text)
  }
  return { units, lines }
}
function snapshot (decl, source, side, base, diagnostic) {
  if (decl === null) return null
  let bytes
  let identity
  if (Object.hasOwn(decl, 'file')) {
    const file = path.resolve(base, decl.file)
    bytes = regularFile(file, MAX_BYTES)
    if (hash(bytes) !== decl.sha256) throw sourceError(`Candidate hash mismatch for ${source}`)
    identity = { kind: 'candidate-file', file, sha256: decl.sha256 }
  } else {
    if (path.posix.isAbsolute(decl.path) || /[\\\x00-\x1f]/.test(decl.path) || decl.path.split('/').some(part => !part || part === '.' || part === '..')) throw sourceError(`Unsafe Git source path for ${source}`)
    let repository
    try { repository = fs.realpathSync(path.resolve(base, decl.repository)) } catch { throw sourceError(`Configured repository is unavailable for ${source}`) }
    const revision = git(repository, 'rev-parse', '--verify', '--end-of-options', `${decl.revision}^{commit}`).toString().trim()
    if (revision !== decl.revision) throw sourceError(`Source ${source} revision must identify the exact commit object`)
    const entry = git(repository, '--literal-pathspecs', 'ls-tree', '-z', revision, '--', decl.path).toString('utf8')
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(entry)
    if (!match || match[3] !== decl.path) throw sourceError(`Source ${source} must identify one regular Git file, not a symlink, directory or submodule`)
    const blob = match[2]
    const size = Number(git(repository, 'cat-file', '-s', blob).toString().trim())
    if (!Number.isSafeInteger(size) || size > MAX_BYTES) throw sourceError(`Source ${source} exceeds ${MAX_BYTES} bytes`)
    bytes = git(repository, 'cat-file', 'blob', blob)
    identity = { kind: 'git', repository, revision, path: decl.path, blob, mode: match[1], sha256: hash(bytes) }
    if (decl.currentRef) {
      if (/[\x00-\x20]/.test(decl.currentRef)) throw configError(`Source ${source} currentRef contains invalid characters`)
      const current = git(repository, 'rev-parse', '--verify', '--end-of-options', `${decl.currentRef}^{commit}`).toString().trim()
      identity.currentRef = decl.currentRef
      identity.currentRefRevision = current
      if (current !== revision) diagnostic('BASE_REF_MOVED', 'error', `Selected ${decl.currentRef} no longer matches pinned ${source} ${side}; no automatic rebasing was attempted`, { source, side })
    }
    try {
      identity.observedHead = git(repository, 'rev-parse', '--verify', 'HEAD').toString().trim()
      if (identity.observedHead !== revision) diagnostic('HEAD_DIFFERS', 'warning', `Working checkout HEAD differs from pinned ${source} ${side}; pinned bytes were retained`, { source, side })
    } catch {}
  }
  const text = decode(bytes, `${source} ${side}`)
  return { ...identity, bytes: bytes.length, text, ...inventoryOf(text) }
}
const sourceIdentity = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => !['text', 'units', 'lines'].includes(key)))
const describe = ref => `${ref.source}:${ref.selector.label || `L${ref.selector.startLine}-${ref.selector.endLine}`}`

function renderPreview (packet) {
  const lines = [
    `change preview: ${packet.title || packet.id}`,
    `structure: ${packet.structurallyValid ? 'valid for declared inputs' : 'unresolved'}; inventory reviewed: ${packet.inventory.reviewed ? 'caller-declared' : 'no'}`,
    'Read-only proposal. Semantic preservation and approval authority are unverified; no publication or retirement attempted.',
    `${packet.changes.length} source comparisons; ${packet.inventory.affectedLabels.length} affected labeled obligations; ${packet.obligations.length} disposition records`,
    ...packet.changes.map(change => `${change.source}: ${change.kind}; diff retained in JSON`),
    ...packet.obligations.map(item => `${item.id}: ${item.disposition} ${describe(item.from)}${item.to.length ? ` -> ${item.to.map(describe).join(', ')}` : ''}`),
    ...packet.diagnostics.map(d => `${d.severity.toUpperCase()} ${d.code}: ${d.message}`)
  ]
  return lines.join('\n')
}

function previewBundle (input, base = process.cwd(), options = {}) {
  const { max_tokens = 6000, require_valid = false } = options
  if (!Number.isSafeInteger(max_tokens) || max_tokens < 500 || max_tokens > 32000) throw usage('Preview budget must be an integer from 500 to 32000 tokens')
  if (typeof require_valid !== 'boolean') throw usage('require_valid must be boolean')
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw configError('Invalid change bundle', { issues: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })) })
  const bundle = parsed.data
  const diagnostics = []
  const diagnostic = (code, severity, message, location = {}) => diagnostics.push({ code, severity, message, location })
  const sourceMap = new Map()
  const aliases = new Map()
  for (const source of bundle.sources) {
    if (sourceMap.has(source.id)) throw configError(`Duplicate source id ${source.id}`)
    if (source.base === null && source.candidate === null) throw configError(`Source ${source.id} has neither base nor candidate`)
    if (source.reference && !/^(?:[\w.-]+\/[\w.-]+#[1-9]\d*|[A-Za-z][A-Za-z0-9_-]*)$/.test(source.reference)) throw configError(`Source ${source.id} has an invalid explicit reference`)
    const row = { id: source.id, ...(source.reference ? { reference: source.reference } : {}),
      base: snapshot(source.base, source.id, 'base', base, diagnostic), candidate: snapshot(source.candidate, source.id, 'candidate', base, diagnostic) }
    sourceMap.set(source.id, row)
    for (const alias of [source.id, source.reference].filter(Boolean)) {
      if (!aliases.has(alias)) aliases.set(alias, new Set())
      aliases.get(alias).add(source.id)
    }
    for (const side of ['base', 'candidate']) {
      const seen = new Set()
      for (const unit of row[side]?.units || []) {
        if (seen.has(unit.label)) diagnostic('DUPLICATE_LABEL', 'error', `${source.id} ${side} repeats ${unit.label}; selectors cannot choose one implicitly`, { source: source.id, side, startLine: unit.startLine })
        seen.add(unit.label)
      }
    }
  }
  for (const [alias, matches] of aliases) if (matches.size > 1) diagnostic('AMBIGUOUS_REFERENCE', 'error', `Explicit reference ${alias} identifies several sources`, { reference: alias })
  const resolveId = value => {
    const matches = aliases.get(value)
    return matches?.size === 1 ? [...matches][0] : null
  }
  const excerpts = []
  const excerptIds = new Map()
  function resolve (ref, side, location) {
    const checked = refSchema.safeParse(ref)
    if (!checked.success) {
      diagnostic('INVALID_SELECTOR', 'error', 'Expected a source and one label or exact line-range selector', location)
      return null
    }
    ref = checked.data
    const sourceId = resolveId(ref.source)
    const doc = sourceMap.get(sourceId)?.[side]
    if (!doc) {
      diagnostic('SOURCE_UNAVAILABLE', 'error', `No selected ${side} source for ${ref.source}`, location)
      return null
    }
    let startLine, endLine
    if (ref.selector.label) {
      const matches = doc.units.filter(unit => unit.label === ref.selector.label)
      if (matches.length !== 1) {
        diagnostic('SELECTOR_UNRESOLVED', 'error', `${describe(ref)} must resolve to exactly one ${side} obligation`, location)
        return null
      }
      ;({ startLine, endLine } = matches[0])
    } else ({ startLine, endLine } = ref.selector)
    if (endLine < startLine || endLine > doc.lines.count) {
      diagnostic('SELECTOR_OUT_OF_RANGE', 'error', `${describe(ref)} exceeds ${side} source lines`, location)
      return null
    }
    const text = doc.lines.slice(startLine, endLine)
    const key = JSON.stringify([sourceId, doc.sha256, startLine, endLine])
    if (!excerptIds.has(key)) {
      const evidence = `e${excerpts.length + 1}`
      excerptIds.set(key, evidence)
      excerpts.push({ id: evidence, source: sourceId, sha256: doc.sha256, startLine, endLine, text })
    }
    return { source: sourceId, side, selector: ref.selector, sha256: doc.sha256, startLine, endLine, text, evidence: excerptIds.get(key) }
  }
  const compact = result => result && ({ source: result.source, selector: result.selector, evidence: result.evidence })
  const affectedLabels = []
  const recognized = []
  const changes = []
  for (const source of sourceMap.values()) {
    const before = source.base?.text || ''
    const after = source.candidate?.text || ''
    for (const side of ['base', 'candidate']) for (const unit of source[side]?.units || []) recognized.push({ source: source.id, side, label: unit.label, startLine: unit.startLine, endLine: unit.endLine })
    for (const unit of source.base?.units || []) {
      const matches = source.candidate?.units.filter(target => target.label === unit.label) || []
      if (matches.length !== 1 || matches[0].contentHash !== unit.contentHash || matches[0].scopeHash !== unit.scopeHash) affectedLabels.push({ source: source.id, label: unit.label, startLine: unit.startLine, endLine: unit.endLine })
    }
    changes.push({ source: source.id, kind: !source.base ? 'addition' : !source.candidate ? 'proposed-removal' : before === after ? 'unchanged' : 'amendment',
      diff: before === after ? '' : createTwoFilesPatch(`${source.id}/base`, `${source.id}/candidate`, before, after, '', '', { context: 3 }) })
  }
  const covered = new Set()
  const fromIdentities = new Set()
  const obligationIds = new Set()
  const obligations = []
  for (let index = 0; index < bundle.obligations.length; index++) {
    const item = bundle.obligations[index]
    const location = { field: 'obligations', index }
    if (obligationIds.has(item.id)) diagnostic('DUPLICATE_OBLIGATION', 'error', `Disposition id ${item.id} is repeated`, location)
    obligationIds.add(item.id)
    const from = resolve(item.from, 'base', location)
    const to = item.to.map(ref => resolve(ref, 'candidate', location))
    if (from) {
      const identity = JSON.stringify([from.source, from.sha256, from.startLine, from.endLine])
      if (fromIdentities.has(identity)) diagnostic('DUPLICATE_DISPOSITION', 'error', `More than one disposition describes ${describe(item.from)}`, location)
      fromIdentities.add(identity)
      const owned = affectedLabels.filter(unit => unit.source === from.source && unit.startLine >= from.startLine && unit.endLine <= from.endLine)
      if (owned.length > 1) diagnostic('MULTIPLE_LABEL_RANGE', 'error', `${item.id} combines several affected labeled obligations; assign each one an explicit disposition`, location)
      else for (const unit of owned) {
        const key = `${unit.source}\0${unit.label}`
        if (covered.has(key)) diagnostic('DUPLICATE_OBLIGATION_COVERAGE', 'error', `${unit.source}:${unit.label} has more than one disposition owner`, location)
        covered.add(key)
      }
    }
    if (['retained', 'moved', 'amended', 'split'].includes(item.disposition) && !item.to.length) diagnostic('MISSING_DESTINATION', 'error', `${item.id} needs a candidate destination`, location)
    if (item.disposition === 'split' && item.to.length < 2) diagnostic('INCOMPLETE_SPLIT', 'error', `${item.id} needs at least two explicit split destinations`, location)
    if (['deferred', 'withdrawn'].includes(item.disposition) && item.to.length) diagnostic('UNEXPECTED_DESTINATION', 'error', `${item.id} ${item.disposition} must not imply a retained destination`, location)
    if (item.disposition === 'deferred') {
      if (!item.owner || !item.rationale) diagnostic('INCOMPLETE_DEFERRAL', 'error', `${item.id} requires an owner and rationale`, location)
      diagnostic('DEFERRED_OBLIGATION', 'error', `${item.id} remains unresolved; deferral does not implement or retire the obligation`, location)
    }
    if (item.disposition === 'withdrawn') {
      if (!item.rationale) diagnostic('MISSING_WITHDRAWAL_RATIONALE', 'error', `${item.id} needs a reviewed withdrawal rationale`, location)
      diagnostic('WITHDRAWAL_NEEDS_REVIEW', 'warning', `${item.id} proposes withdrawal; the preview does not establish authorization`, location)
    }
    const destinations = new Set()
    for (const target of to.filter(Boolean)) {
      const key = JSON.stringify([target.source, target.sha256, target.startLine, target.endLine])
      if (destinations.has(key)) diagnostic('DUPLICATE_DESTINATION', 'error', `${item.id} repeats a destination`, location)
      destinations.add(key)
    }
    obligations.push({ ...item, from: compact(from) || item.from, to: to.map((target, i) => compact(target) || item.to[i]), semanticPreservationVerified: false })
  }
  const uncovered = affectedLabels.filter(unit => !covered.has(`${unit.source}\0${unit.label}`))
  for (const unit of uncovered) diagnostic('UNASSIGNED_OBLIGATION', 'error', `${unit.source}:${unit.label} changed or was removed without a disposition`, { source: unit.source, side: 'base', startLine: unit.startLine })
  if (!bundle.inventory.reviewed) diagnostic('INVENTORY_NOT_REVIEWED', 'error', 'The caller has not confirmed review of the obligation inventory, including stories, scope, defaults and prose')
  const provides = []
  for (let index = 0; index < bundle.provides.length; index++) {
    const entry = bundle.provides[index]
    const location = { field: 'provides', index }
    if (!object(entry) || Object.keys(entry).some(key => !['capability', 'source', 'selector'].includes(key)) || !id.safeParse(entry.capability).success) {
      diagnostic('INVALID_PROVISION', 'error', 'Provision requires a capability and source selector', location)
      continue
    }
    const target = resolve({ source: entry.source, selector: entry.selector }, 'candidate', location)
    if (target) provides.push({ capability: entry.capability, ...compact(target), declarationOnly: true })
  }
  const requirements = []
  for (let index = 0; index < bundle.requires.length; index++) {
    const entry = bundle.requires[index]
    const location = { field: 'requires', index }
    if (!object(entry) || Object.keys(entry).some(key => !['capability', 'consumer', 'provider'].includes(key)) || !id.safeParse(entry.capability).success || typeof entry.consumer !== 'string' || (entry.provider !== undefined && typeof entry.provider !== 'string')) {
      diagnostic('INVALID_REQUIREMENT', 'error', 'Capability requirement needs a capability, consumer and optional selected provider', location)
      continue
    }
    const consumer = resolveId(entry.consumer)
    const provider = entry.provider === undefined ? null : resolveId(entry.provider)
    if (!sourceMap.get(consumer)?.candidate) diagnostic('CONSUMER_UNAVAILABLE', 'error', `No candidate consumer ${entry.consumer}`, location)
    const options = provides.filter(provision => provision.capability === entry.capability && (entry.provider === undefined || provision.source === provider))
    const choices = [...new Set(options.map(provision => provision.source))]
    if (!options.length) diagnostic('MISSING_CAPABILITY', 'error', `Required capability ${entry.capability} has no selected candidate provider`, location)
    else if (choices.length > 1 && entry.provider === undefined) diagnostic('AMBIGUOUS_CAPABILITY', 'error', `${entry.capability} needs an explicit provider selection`, location)
    requirements.push({ ...entry, consumer: consumer || entry.consumer, providers: choices, resolved: options.length > 0 && choices.length === 1, declarationOnly: true })
  }
  const relations = []
  const relationKeys = new Set()
  const addRelation = (entry, location) => {
    if (!object(entry) || Object.keys(entry).some(key => !['type', 'from', 'to'].includes(key)) || !['normative', 'implementation', 'publication', 'supersedes'].includes(entry.type) || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      diagnostic('INVALID_RELATION', 'error', 'Relation needs a supported type, from and to source reference', location)
      return
    }
    const from = resolveId(entry.from)
    const to = resolveId(entry.to)
    const target = sourceMap.get(to)
    const historical = ['normative', 'supersedes'].includes(entry.type)
    if (!sourceMap.get(from)?.candidate || !target || (!historical && !target.candidate)) {
      diagnostic('UNRESOLVED_RELATION', 'error', `${entry.type} relation ${entry.from} -> ${entry.to} cannot resolve selected sources`, location)
      return
    }
    const key = `${entry.type}\0${from}\0${to}`
    if (relationKeys.has(key)) {
      diagnostic('DUPLICATE_RELATION', 'error', `Repeated ${entry.type} relation ${from} -> ${to}`, location)
      return
    }
    relationKeys.add(key)
    relations.push({ type: entry.type, from, to })
  }
  bundle.relations.forEach((entry, index) => addRelation(entry, { field: 'relations', index }))
  for (const source of sourceMap.values()) {
    const text = source.candidate?.text
    if (!text || !/^---\r?\n/.test(text)) continue
    const lines = text.split(/\r\n|\r|\n/)
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line))
    const location = { source: source.id, side: 'candidate', startLine: 1, field: 'frontmatter' }
    if (end < 0) {
      diagnostic('INVALID_FRONTMATTER', 'error', 'Frontmatter has no closing delimiter', location)
      continue
    }
    let metadata
    try { metadata = YAML.load(lines.slice(1, end).join('\n'), { schema: YAML.CORE_SCHEMA }) } catch (e) {
      diagnostic('INVALID_FRONTMATTER', 'error', `Cannot parse candidate frontmatter: ${e.message}`, location)
      continue
    }
    if (!object(metadata)) {
      diagnostic('INVALID_FRONTMATTER', 'error', 'Candidate frontmatter must be a mapping', location)
      continue
    }
    if (Object.hasOwn(metadata, 'depends-on')) {
      if (!Array.isArray(metadata['depends-on']) || metadata['depends-on'].length > 512) diagnostic('INVALID_RELATION', 'error', 'depends-on must be an array of at most 512 entries; no value was silently discarded', { ...location, field: 'depends-on' })
      else metadata['depends-on'].forEach((to, index) => addRelation({ type: 'implementation', from: source.id, to }, { ...location, field: 'depends-on', index }))
    }
    if (Object.hasOwn(metadata, 'supersedes')) addRelation({ type: 'supersedes', from: source.id, to: metadata.supersedes }, { ...location, field: 'supersedes' })
  }
  for (const type of ['normative', 'implementation', 'publication', 'supersedes']) {
    const edges = relations.filter(edge => edge.type === type)
    const visiting = new Set(), visited = new Set(), trail = []
    const visit = node => {
      if (visiting.has(node)) {
        diagnostic('RELATION_CYCLE', type === 'normative' ? 'warning' : 'error', `${type} cycle: ${[...trail.slice(trail.indexOf(node)), node].join(' -> ')}${type === 'normative' ? '; review coordinated references' : ''}`, { field: 'relations', type })
        return
      }
      if (visited.has(node)) return
      visiting.add(node); trail.push(node)
      for (const edge of edges.filter(edge => edge.from === node)) visit(edge.to)
      trail.pop(); visiting.delete(node); visited.add(node)
    }
    for (const edge of edges) visit(edge.from)
  }
  const checkedRules = require('./preview-rules').checkRules({ rules: bundle.rules, exceptions: bundle.exceptions, stage: bundle.stage, asOf: bundle.asOf }, {
    candidateIds: [...sourceMap.values()].filter(source => source.candidate).map(source => source.id), relations,
    resolve: ref => {
      const selected = resolve(ref, 'candidate', { field: 'rules' })
      return selected && { source: selected.source, sha256: selected.sha256, startLine: selected.startLine, endLine: selected.endLine, text: selected.text }
    }
  })
  diagnostics.push(...checkedRules.diagnostics)
  const packet = { schemaVersion: 1, kind: 'specdoc-change-preview', id: hash(JSON.stringify(bundle)), ...(bundle.title ? { title: bundle.title } : {}),
    identityScope: 'normalized-bundle-declaration', readOnly: true, semanticPreservationVerified: false, authorityVerified: false, publicationAttempted: false,
    sources: [...sourceMap.values()].map(source => ({ id: source.id, ...(source.reference ? { reference: source.reference } : {}), base: sourceIdentity(source.base), candidate: sourceIdentity(source.candidate) })),
    changes, inventory: { ...bundle.inventory, declarationOnly: true, recognized, affectedLabels, uncovered }, obligations, excerpts, provides, requires: requirements,
    relations, consistencyReview: relations.filter(edge => ['normative', 'implementation', 'supersedes'].includes(edge.type)),
    ruleChecks: checkedRules.ruleChecks, exceptions: checkedRules.exceptions, diagnostics, structurallyValid: !diagnostics.some(item => item.severity === 'error'),
    limits: [
      'Inventory review and source authority are caller declarations; this preview does not authenticate approval or establish inventory completeness.',
      'The preview id hashes its normalized bundle declaration only; observed source facts and the result packet have no signed content identity.',
      'Recognized labels are document-level FR/SC list items only; stories, defaults, exclusions and prose need an explicitly reviewed inventory.',
      'Resolved dispositions, capability provisions and relations do not establish semantic preservation or implementation conformance.',
      'Selected excerpts do not include every surrounding scope; review the pinned source documents and exact diff before accepting a transfer.',
      'Rule checks cover selected declarations only; no project or check commands executed, files changed, network was contacted or lifecycle state was updated.',
      'Publication cycles require a separately reviewed coordination design; normative-reference cycles remain advisory.'
    ], text: '' }
  packet.text = renderPreview(packet)
  const normalSize = Math.ceil(JSON.stringify({ schemaVersion: 1, data: packet }).length / 4)
  const strictSize = Math.ceil(JSON.stringify({ schemaVersion: 1, error: { code: 'INVALID_CHANGE', message: STRICT_MESSAGE, details: { packet } } }).length / 4)
  const minimumTokens = Math.max(normalSize, strictSize)
  if (minimumTokens > max_tokens) throw new OperationError('BUDGET_TOO_SMALL', 'The complete preview and its evidence do not fit; narrow the bundle or raise max_tokens', { minimumTokens, maxTokens: max_tokens })
  if (require_valid && !packet.structurallyValid) throw new OperationError('INVALID_CHANGE', STRICT_MESSAGE, { packet })
  return packet
}

function previewFile (file, options = {}) {
  const resolved = path.resolve(file)
  let bundle
  try {
    const text = decode(regularFile(resolved, MAX_CONFIG_BYTES), 'Change bundle')
    bundle = JSON.parse(text)
    YAML.load(text, { schema: YAML.CORE_SCHEMA })
  } catch (e) {
    throw configError(`Cannot read or parse change bundle: ${e.message}`)
  }
  return previewBundle(bundle, path.dirname(resolved), options)
}

module.exports = { previewFile, previewBundle, renderPreview }
