'use strict'
const path = require('path')
const { readGit, stateSuffix } = require('./git')
const { Index, LANGS, git } = require('./index')
const { Specs } = require('./specs')
const { Trace } = require('./trace')
const { clip } = require('./budget')
const { context, getSection } = require('./context')
const { loadManifest, ManifestSpecs } = require('./manifest')

const REPO = path.resolve(process.env.SPECDOC_REPO || process.cwd())
const BOARD = process.env.SPECDOC_URL || 'http://localhost:8080'
const ENV_NS = (process.env.SPECDOC_NAMESPACE || '').split(',').map(s => s.trim()).filter(Boolean)

const commitLine = c => `commit:${c.sha}  ${c.subject}`
// A bare number is read against the scope: "#7" means issue 7 of the spec
// repo this checkout answers to, so it names nothing outside it.
const BARE_REF = /^#?\d+$/

function repositoryState (index) {
  const gaps = []
  let head = null
  let untrackedFiles = null
  try { head = readGit(index.repo, ['rev-parse', '--verify', 'HEAD']).trim() } catch { gaps.push({ code: 'HEAD_UNAVAILABLE', message: 'Full implementation HEAD is unavailable' }) }
  try { untrackedFiles = readGit(index.repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).length } catch { gaps.push({ code: 'UNTRACKED_INVENTORY_UNAVAILABLE', message: 'Untracked file count is unavailable' }) }
  const trackedFiles = index.tracked.size
  const supportedTrackedFiles = [...index.tracked].filter(file => LANGS[path.extname(file)]).length
  if (untrackedFiles) gaps.push({ code: 'UNTRACKED_FILES_NOT_INDEXED', message: `${untrackedFiles} untracked files are outside the code index` })
  for (const file of index.submodules || []) gaps.push({ code: 'SUBMODULE_NOT_INSPECTED', path: file, message: 'Submodule working trees are not inspected; their local state is unknown' })
  if (supportedTrackedFiles > index.files.size) gaps.push({ code: 'TRACKED_SOURCE_NOT_INDEXED', message: `${supportedTrackedFiles - index.files.size} supported tracked paths were not indexed (for example missing files or symlinks)` })
  const dirty = index.dirty === true || untrackedFiles > 0 ? true : index.dirty === null || untrackedFiles === null ? null : false
  return { head, untrackedFiles, dirty,
    codeIndexCoverage: { trackedFiles, parsedFiles: index.files.size, unparsedTrackedFiles: trackedFiles - index.files.size,
      supportedExtensions: Object.keys(LANGS), untrackedFiles, gaps,
      limits: ['Only tracked regular files in supported languages have symbol/reference edges; other tracked regular files can be retrieved by file id', 'Untracked files and symlinks are not indexed', 'Coverage facts do not establish requirement conformance'] } }
}

const ago = ms => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

class Context {
  constructor (repo = REPO, url = BOARD, namespaces = ENV_NS, { manifest = null } = {}) {
    this.index = new Index(repo)
    this.log = new Trace(repo)
    this.specs = new Specs(url)
    this.namespaces = namespaces
    this.manifestPath = manifest
  }

  async refresh () {
    if (this.manifestPath) {
      this.manifest = loadManifest(this.manifestPath)
      if (path.resolve(this.index.repo) !== path.resolve(this.manifest.implementation.repository)) throw new Error('Manifest implementation repository does not match the selected checkout')
      if (this.namespaces.length && this.manifest.sources.some(s => !this.namespaces.includes(s.namespace))) throw new Error('Configured namespaces exclude a manifest source; use the manifest namespace selection')
      this.specs = new ManifestSpecs(this.manifest)
      this.log.configure?.(this.manifest.sources)
    }
    this.index.refresh()
    this.repositoryState = repositoryState(this.index)
    this.log.refresh(this.index.head)
    // Without a configured namespace the implements-commits say which spec
    // repos this checkout answers to.
    if (!this.manifest) {
      this.specs.namespaces = this.namespaces.length ? this.namespaces : this.log.namespaces('implements')
      this.specs.strict = this.namespaces.length > 0
    }
    await this.specs.load()
    if (!this.manifest) {
      const sources = this.specs.specs.filter(spec => typeof spec.namespace === 'string' && typeof spec.specPath === 'string').map(spec => ({
        id: spec.id, namespace: spec.namespace, path: spec.specPath,
        ...(Number.isSafeInteger(spec.pr) && spec.pr > 0 ? { reference: `${spec.namespace}#${spec.pr}` } : {})
      }))
      this.log.configure(sources).refresh(this.index.head)
    }
    return this
  }

  header () {
    const ix = this.index
    const sp = this.specs
    if (this.manifest) return `index ${ix.head}${stateSuffix(ix.dirty)}: ${ix.files.size} files, ${ix.count()} symbols; pinned manifest ${this.manifest.id}; ${sp.specs.length} Git sources (${sp.scope})`
    // The board's own observation time when it sent one, otherwise the time
    // this process last read it, which is the closest bound available. A first
    // load that failed has neither, and still reaches here: the tool reports
    // the failure with this header on it.
    const read = Date.parse(sp.at || '')
    const age = Number.isFinite(read)
      ? `board read ${ago(Date.now() - read)} ago`
      : sp.fetchedAt ? `fetched ${ago(Date.now() - sp.fetchedAt)} ago` : 'never fetched'
    const scope = sp.scope === 'all' ? '; scope: every project on the board, because SPECDOC_NAMESPACE is unset and no implements commits named one' : ''
    return `index ${ix.head}${stateSuffix(ix.dirty)}: ${ix.files.size} files, ${ix.count()} symbols; specs: ${sp.specs.length} (${sp.scope}), ${age}${sp.error ? `, stale: ${sp.error}` : ''}${scope}`
  }

  // Scope first, then the corpus: a reference that names one spec wherever it
  // lives is read outside the scope, and the caller is told so. A bare number
  // is the exception, since it is read against the scope in the first place.
  specHit (rest) {
    const s = this.specs.resolve(rest)
    if (s) return { type: 'spec', s }
    if (BARE_REF.test(rest)) return null
    const o = this.specs.outside(rest)
    return o ? { type: 'spec', s: o, outsideScope: true } : null
  }

  // A spec id in any spelling search() prints, or a note id the board takes
  // as it is.
  noteId (id) {
    const v = String(id).trim()
    const hit = this.specHit(v.replace(/^spec:/, ''))
    return hit ? hit.s.id : v
  }

  // Ids are explicit when prefixed; bare forms fall back to what they look
  // like, so an agent can paste "src/lib.rs#Lease" or "netfyr/specs#7".
  resolve (id) {
    const v = String(id).trim()
    const m = /^(sym|file|spec|commit):(.*)$/.exec(v)
    const want = m ? m[1] : null
    const rest = (m ? m[2] : v).trim()
    if (want === 'sym' || (!want && /#[^\d]/.test(rest))) {
      const d = this.index.resolve(rest)
      return d ? { type: 'sym', d } : null
    }
    if (want === 'spec' || (!want && /#\d+$/.test(rest))) return this.specHit(rest)
    const f = this.index.file(rest)
    if (want === 'file' || (!want && f)) {
      return f ? { type: 'file', file: rest, f } : null
    }
    if (want === 'commit' || (!want && /^[0-9a-f]{7,40}$/.test(rest))) {
      const c = this.log.commits.find(c => rest.startsWith(c.sha) || c.sha.startsWith(rest))
      return c ? { type: 'commit', c } : null
    }
    return this.specHit(rest)
  }

  sym (d, level = 'fold') {
    let out = `${this.index.idOf(d)}  ${d.kind} L${d.line}-${d.endLine}`
    if (level === 'preview') out += `\n    ${d.sig}`
    if (level === 'full') out += `\n${this.index.source(d)}`
    return out
  }

  spec (s, level = 'fold') {
    let out = `${this.specs.idOf(s)}  ${s.status}${s.superseded ? ' (retired)' : ''}  ${s.title}`
    if (level !== 'fold' && s.abstract) out += `\n    ${s.abstract}`
    return out
  }

  // A reference the board may or may not know: a commit can name a spec that
  // was never a note, one this checkout's namespaces exclude, or one that is
  // simply misspelled. The middle case is on the board and says so.
  refLine (ref) {
    if (typeof ref === 'object' && ref.resolution === 'unresolved') return `spec-path:${ref.path}  (unresolved: ${ref.reason})`
    const label = typeof ref === 'object' ? ref.label : ref
    const s = this.specs.resolve(label)
    if (s) return this.spec(s)
    const o = this.specs.outside(label)
    return o ? `${this.spec(o)}  (outside scope)` : `spec:${label}  (not on the board)`
  }

  specsFor (file) {
    const refs = new Map(this.log.forFile(file).flatMap(c => c.refs.map(r => [`${r.relation}:${r.label}`, r])))
    return [...refs.values()].map(r => `${r.relation === 'contributes_to' ? 'contributes to' : 'implements'} ${this.refLine(r)}`)
  }

  search ({ query, kind, level, limit, max_tokens }) {
    const q = query.trim()
    const ql = q.toLowerCase()
    if (!ql) return 'empty query'
    const blocks = []
    if (kind !== 'spec') {
      const tier = d => d.name === q ? 0 : d.name.toLowerCase().startsWith(ql) ? 1 : d.name.toLowerCase().includes(ql) ? 2 : d.file.toLowerCase().includes(ql) ? 3 : 9
      const hits = [...this.index.defs()].map(d => ({ d, t: tier(d) })).filter(x => x.t < 9)
        .sort((a, b) => a.t - b.t || a.d.file.localeCompare(b.d.file) || a.d.line - b.d.line)
      if (hits.length) blocks.push(`symbols (${hits.length}):`, ...hits.slice(0, limit).map(x => this.sym(x.d, level)))
    }
    if (kind !== 'symbol') {
      const hits = this.specs.search(q)
      if (hits.length) blocks.push(`specs (${hits.length}):`, ...hits.slice(0, limit).map(s => this.spec(s, level)))
    }
    if (!blocks.length) return 'no match; try a shorter name or a path fragment'
    return clip(blocks, max_tokens, 'narrow with kind= or a longer query, or lower level=')
  }

  neighbors ({ id, direction, max_tokens }) {
    const r = this.resolve(id)
    if (!r) return null
    const ix = this.index
    const blocks = []
    const section = (title, items) => { if (items.length) blocks.push(`${title} (${items.length}):`, ...items) }
    if (r.type === 'sym') {
      const d = r.d
      blocks.push(this.sym(d, 'preview'))
      if (direction !== 'out') {
        section('referenced by', ix.refsTo(d).map(x => `${x.file}:${x.line}  ${x.kind}${x.in ? `  in ${ix.idOf(x.in)}` : ''}`))
      }
      if (direction !== 'in') section('references', ix.refsFrom(d).map(x => this.sym(x)))
      blocks.push(`in file:${d.file}`)
      section('specs', this.specsFor(d.file))
    } else if (r.type === 'spec') {
      const s = r.s
      if (r.outsideScope) blocks.push(`Outside this checkout's scope (${this.specs.scope}); dependents and replacements are not listed.`)
      blocks.push(this.spec(s, 'preview'))
      section('depends on', s.dependsOn.map(l => this.refLine(l)))
      if (s.supersedes) blocks.push(`supersedes: ${this.refLine(s.supersedes)}`)
      section('needed by', this.specs.neededBy(s).map(t => this.spec(t)))
      section('superseded by', this.specs.supersededBy(s).map(t => this.spec(t)))
      const commits = this.log.forSpec(s)
      section('commits', commits.map(commitLine))
      section('files', [...new Set(commits.flatMap(c => c.files))].map(f => `file:${f}`))
    } else if (r.type === 'file') {
      blocks.push(`file:${r.file}  ${r.f.defs.length} symbols`)
      section('defines', r.f.defs.map(d => this.sym(d)))
      section('used by', ix.usersOf(r.f).map(x => `file:${x}`))
      section('specs', this.specsFor(r.file))
    } else {
      const c = r.c
      blocks.push(commitLine(c))
      section('implements', c.refs.filter(x => x.relation === 'implements').map(x => this.refLine(x)))
      section('contributes to', c.refs.filter(x => x.relation === 'contributes_to').map(x => this.refLine(x)))
      section('files', c.files.map(f => `file:${f}`))
    }
    return clip(blocks, max_tokens, r.type === 'sym' ? 'pass direction=in|out or raise max_tokens' : 'raise max_tokens')
  }

  // Long bodies are cut line by line, so a symbol or spec bigger than the
  // budget still shows its head rather than vanishing whole.
  async get ({ id, max_tokens }) {
    if (id.startsWith('section:')) return getSection(this, { id, max_tokens })
    const r = this.resolve(id)
    if (!r) return null
    if (r.type === 'commit') return this.neighbors({ id, direction: 'both', max_tokens })
    const lines = []
    if (r.type === 'sym') {
      lines.push(this.sym(r.d, 'preview'), ...this.index.source(r.d).split('\n'))
    } else if (r.type === 'file') {
      lines.push(`file:${r.file}  ${r.f.text.split('\n').length} lines`, ...r.f.defs.map(d => this.sym(d, 'preview')), this.traceText(r))
    } else {
      const s = r.s
      if (r.outsideScope) lines.push(`Outside this checkout's scope (${this.specs.scope}); read from the board.`)
      if (s.superseded) lines.push('This spec is retired.')
      lines.push(
        this.spec(s, 'preview'),
        this.facts(s),
        ...(await this.specs.body(s)).split('\n'),
        this.traceText(r)
      )
    }
    return clip(lines, max_tokens, 'raise max_tokens, or ask neighbors() for the shape without the text')
  }

  // One line, whatever the board sent: an agent reading a spec needs the
  // replacement, the approval gate and the plan before it reads the text.
  facts (s) {
    const parts = [
      `namespace: ${s.namespace}`,
      `area: ${s.area || '-'}`,
      `kind: ${s.kind}`,
      `pr: ${s.pr ? `#${s.pr} (${s.prState})` : 'none'}`,
      `path: ${s.specPath || '-'}`,
      `url: ${s.url}`
    ]
    if (s.superseded) {
      const by = this.specs.supersededBy(s)
      parts.push(by.length ? `retired: superseded by ${this.specs.idOf(by[0])} ${by[0].title}` : 'retired: replacement not in this scope')
    }
    parts.push(`open comments: ${s.comments || 0}`, `pending suggestions: ${s.suggestions || 0}`)
    if (s.milestone) parts.push(`milestone: ${s.milestone.title} (${s.milestone.state})`)
    const people = (s.implementers || []).map(u => u.login || u.name).filter(Boolean)
    if (people.length) parts.push(`implementers: ${people.join(', ')}`)
    return parts.join('  ').replace(/[\r\n]+/g, ' ')
  }

  traceText (r) {
    const ix = this.index
    const lines = ['trace: file-level commit references; not symbol attribution or requirement verification']
    if (r.type === 'spec') {
      const s = r.s
      const commits = this.log.forSpec(s)
      if (!commits.length) return `trace: no contribution or completion reference matches ${this.specs.idOf(s)}; Spec: paths need configured sources`
      for (const c of commits) {
        const relations = [...new Set(this.log.refsForSpec(c, s).map(x => x.relation))]
        lines.push(`${commitLine(c)}  [${relations.join(', ')}]`)
        for (const f of c.files) {
          const defs = ix.files.has(f) ? ix.files.get(f).defs : []
          lines.push(`  file:${f}${defs.length ? `  ${defs.map(d => `${d.kind} ${d.name}`).join(', ')}` : ''}`)
        }
      }
      return lines.join('\n')
    }
    const file = r.type === 'sym' ? r.d.file : r.type === 'file' ? r.file : null
    const commits = file ? this.log.forFile(file) : [r.c]
    if (!commits.length) return `trace: no contribution or completion reference touches ${file}`
    for (const c of commits) {
      lines.push(commitLine(c))
      for (const x of c.refs) lines.push(`  ${x.relation === 'contributes_to' ? 'contributes to' : 'implements'} ${this.refLine(x)}`)
    }
    return lines.join('\n')
  }

  trace ({ id, max_tokens }) {
    const r = this.resolve(id)
    if (!r) return null
    const lines = r.outsideScope ? [`Outside this checkout's scope (${this.specs.scope}); any commit here that names it is still listed.`] : []
    lines.push(...this.traceText(r).split('\n'))
    return clip(lines, max_tokens, 'ask neighbors() on one commit or file')
  }

  // A starting map: the specs an agent should know exist, then the symbols
  // the rest of the code leans on, signatures only. The specs get a fixed
  // share so a large codebase cannot push them out.
  brief ({ max_tokens }) {
    const specBudget = Math.floor(max_tokens * 0.3)
    const live = this.specs.specs.filter(s => !s.superseded)
    const counts = {}
    for (const s of live) counts[s.status] = (counts[s.status] || 0) + 1
    const shown = live.filter(s => ['approved', 'implemented'].includes(s.status))
    const specText = clip([
      `specs: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`,
      ...shown.map(s => this.spec(s))
    ], specBudget, 'search(kind=spec) lists the rest')
    if (!this.index.files.size) return `${specText}\n\nno indexed code: the index covers ${Object.keys(LANGS).join(', ')} files and this checkout has none`
    let recent = new Set()
    try {
      recent = new Set(git(this.index.repo, 'log', '-20', '--name-only', '--format=').split('\n').filter(Boolean))
    } catch {}
    const byFile = new Map()
    for (const { d, s } of this.index.ranked(recent)) {
      if (!byFile.has(d.file)) byFile.set(d.file, { s, defs: [] })
      byFile.get(d.file).defs.push(d)
    }
    const files = [...byFile.entries()].sort((a, b) => b[1].s - a[1].s)
      .map(([file, { defs }]) => [`${file}:`, ...defs.sort((a, b) => a.line - b.line).map(d => `  ${d.sig}`)].join('\n'))
    return `${specText}\n\n${clip(files, max_tokens - specBudget, 'search() finds the rest')}`
  }

  async context (args) {
    return context(this, args)
  }

  async contextPacket (args) {
    return context(this, args, { structured: true })
  }
}

module.exports = { Context }
