#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')
const { z } = require('zod')
const { Index, LANGS, git } = require('./index')
const { Specs } = require('./specs')
const { Trace } = require('./trace')
const { clip } = require('./budget')

const REPO = path.resolve(process.env.SPECDOC_REPO || process.cwd())
const BOARD = process.env.SPECDOC_URL || 'https://specs.josie.cloud'
// A budget under 50 tokens holds nothing but a trailer.
const tokens = z.coerce.number().int().min(50).max(20000)
const MAX_TOKENS = tokens.catch(1500).parse(process.env.SPECDOC_MAX_TOKENS)
// The brief splits its budget 30/70 between specs and code; under 200 one
// side is nothing but a trailer.
const briefTokens = tokens.min(200)
const BRIEF_TOKENS = briefTokens.catch(1000).parse(process.env.SPECDOC_BRIEF_TOKENS)
const ENV_NS = (process.env.SPECDOC_NAMESPACE || '').split(',').map(s => s.trim()).filter(Boolean)

const ID = 'sym:<path>#<name>, file:<path>, spec:<owner/repo#N>, or commit:<sha>; bare forms are guessed'
const commitLine = c => `commit:${c.sha}  ${c.subject}`

class Context {
  constructor (repo = REPO, url = BOARD, namespaces = ENV_NS) {
    this.index = new Index(repo)
    this.log = new Trace(repo)
    this.specs = new Specs(url)
    this.namespaces = namespaces
  }

  async refresh () {
    this.index.refresh()
    this.log.refresh(this.index.head)
    // Without a configured namespace the implements-commits say which spec
    // repos this checkout answers to.
    this.specs.namespaces = this.namespaces.length ? this.namespaces : this.log.namespaces()
    this.specs.strict = this.namespaces.length > 0
    await this.specs.load()
    return this
  }

  header () {
    const ix = this.index
    const sp = this.specs
    const scope = sp.scope === 'all' ? '; scope: every namespace on the board, because SPECDOC_NAMESPACE is unset and no implements commits named one' : ''
    return `index ${ix.head}${ix.dirty ? '+dirty' : ''}: ${ix.files.size} files, ${ix.count()} symbols; specs: ${sp.specs.length} (${sp.scope})${sp.error ? `, stale: ${sp.error}` : ''}${scope}`
  }

  // Ids are explicit when prefixed; bare forms fall back to what they look
  // like, so an agent can paste "src/lib.rs#Lease" or "netfyr/specs#7".
  resolve (id) {
    const v = String(id).trim()
    const m = /^(sym|file|spec|commit):(.*)$/.exec(v)
    const want = m ? m[1] : null
    const rest = m ? m[2] : v
    if (want === 'sym' || (!want && /#[^\d]/.test(rest))) {
      const d = this.index.resolve(rest)
      return d ? { type: 'sym', d } : null
    }
    if (want === 'spec' || (!want && /#\d+$/.test(rest))) {
      const s = this.specs.resolve(rest)
      return s ? { type: 'spec', s } : null
    }
    const f = this.index.file(rest)
    if (want === 'file' || (!want && f)) {
      return f ? { type: 'file', file: rest, f } : null
    }
    if (want === 'commit' || (!want && /^[0-9a-f]{7,40}$/.test(rest))) {
      const c = this.log.commits.find(c => rest.startsWith(c.sha) || c.sha.startsWith(rest))
      return c ? { type: 'commit', c } : null
    }
    const s = this.specs.resolve(rest)
    return s ? { type: 'spec', s } : null
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

  // A reference the board may or may not know: a commit can name a spec
  // that was never a note, or one this checkout's namespaces exclude.
  refLine (label) {
    const s = this.specs.resolve(label)
    return s ? this.spec(s) : `spec:${label}  (not on the board)`
  }

  specsFor (file) {
    return [...new Set(this.log.forFile(file).flatMap(c => c.refs.map(r => r.label)))].map(l => this.refLine(l))
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
      section('implements', c.refs.map(x => this.refLine(x.label)))
      section('files', c.files.map(f => `file:${f}`))
    }
    return clip(blocks, max_tokens, r.type === 'sym' ? 'pass direction=in|out or raise max_tokens' : 'raise max_tokens')
  }

  // Long bodies are cut line by line, so a symbol or spec bigger than the
  // budget still shows its head rather than vanishing whole.
  async get ({ id, max_tokens }) {
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
    const lines = []
    if (r.type === 'spec') {
      const s = r.s
      const commits = this.log.forSpec(s)
      if (!commits.length) return `trace: no commit in this checkout says "implements ${s.namespace}#${s.pr || '?'}"`
      for (const c of commits) {
        lines.push(commitLine(c))
        for (const f of c.files) {
          const defs = ix.files.has(f) ? ix.files.get(f).defs : []
          lines.push(`  file:${f}${defs.length ? `  ${defs.map(d => `${d.kind} ${d.name}`).join(', ')}` : ''}`)
        }
      }
      return lines.join('\n')
    }
    const file = r.type === 'sym' ? r.d.file : r.type === 'file' ? r.file : null
    const commits = file ? this.log.forFile(file) : [r.c]
    if (!commits.length) return `trace: no implements-commit touches ${file}`
    for (const c of commits) {
      lines.push(commitLine(c))
      for (const x of c.refs) lines.push(`  ${this.refLine(x.label)}`)
    }
    return lines.join('\n')
  }

  trace ({ id, max_tokens }) {
    const r = this.resolve(id)
    if (!r) return null
    return clip(this.traceText(r).split('\n'), max_tokens, 'ask neighbors() on one commit or file')
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
}

const render = (ctx, body) => `${ctx.header()}\n\n${body}`
const maxTokens = tokens.default(MAX_TOKENS).describe('response budget; whole items are dropped past it')

async function serve () {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
  const ctx = new Context()
  const server = new McpServer({ name: 'specdoc', version: require('./package.json').version })
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
  const run = fn => async args => {
    try {
      await ctx.refresh()
      const body = await fn(args)
      if (body === null) return text(render(ctx, `unknown id ${args.id}; ${ID}. search() prints exact ids.`), true)
      return text(render(ctx, body))
    } catch (e) {
      return text(render(ctx, `error: ${e.message}`), true)
    }
  }
  server.registerTool('search', {
    description: 'Find symbols (by name, then by path fragment) and specs (by words in title or abstract). Returns ids for the other tools. Start here.',
    inputSchema: {
      query: z.string().min(1),
      kind: z.enum(['symbol', 'spec']).optional().describe('restrict to one side'),
      level: z.enum(['fold', 'preview', 'full']).default('fold').describe('fold: one line; preview: plus signature or abstract; full: plus source'),
      limit: z.number().int().positive().max(200).default(20),
      max_tokens: maxTokens
    }
  }, run(a => ctx.search(a)))
  server.registerTool('neighbors', {
    description: `One hop around an id: callers and callees of a symbol, the symbols of a file and who uses it, the dependencies, dependents and implementing commits of a spec. ${ID}.`,
    inputSchema: {
      id: z.string().min(1),
      direction: z.enum(['in', 'out', 'both']).default('both').describe('in: who uses it; out: what it uses'),
      max_tokens: maxTokens
    }
  }, run(a => ctx.neighbors(a)))
  server.registerTool('get', {
    description: `Everything about one id: a symbol's source, a file's outline, a spec's published body with its implementing commits. ${ID}.`,
    inputSchema: { id: z.string().min(1), max_tokens: maxTokens }
  }, run(a => ctx.get(a)))
  server.registerTool('trace', {
    description: `Spec to code and back: which commits and files implement a spec, or which specs a symbol or file implements. ${ID}.`,
    inputSchema: { id: z.string().min(1), max_tokens: maxTokens }
  }, run(a => ctx.trace(a)))
  server.registerTool('brief', {
    description: 'A budgeted map of the repo: spec index and the most referenced symbols with signatures. Call once at the start of a task.',
    inputSchema: { max_tokens: briefTokens.default(BRIEF_TOKENS) }
  }, run(a => ctx.brief(a)))
  await server.connect(new StdioServerTransport())
}

async function briefCli (argv) {
  const { values: { out } } = parseArgs({ args: argv.slice(1), options: { out: { type: 'string' } } })
  const ctx = await new Context().refresh()
  const text = `${render(ctx, ctx.brief({ max_tokens: BRIEF_TOKENS }))}\n`
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, text)
  } else {
    process.stdout.write(text)
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  const main = argv[0] === 'brief' ? briefCli(argv) : serve()
  main.catch(e => { console.error(e.message); process.exit(1) })
} else {
  module.exports = { Context }
}
