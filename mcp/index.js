const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const Parser = require('tree-sitter')

const LANGS = {
  '.rs': {
    lang: require('tree-sitter-rust'),
    query: fs.readFileSync(require.resolve('tree-sitter-rust/queries/tags.scm'), 'utf8') +
      fs.readFileSync(path.join(__dirname, 'queries', 'rust.scm'), 'utf8')
  }
}

const regular = p => { try { return fs.lstatSync(p).isFile() } catch { return false } }
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] })

// The kind an agent reads: the node type minus its suffix, methods told apart
// from free functions by which pattern matched.
function kindOf (capture, node) {
  if (capture === 'definition.method') return 'method'
  const t = node.type.replace(/_item$|_definition$/, '')
  return t === 'function' ? 'fn' : t
}

class Index {
  constructor (repo) {
    this.repo = repo
    this.files = new Map()
    this.tracked = new Set()
    this.parsers = new Map()
    this.names = null
    this.head = ''
    this.dirty = false
  }

  parserFor (ext) {
    if (!this.parsers.has(ext)) {
      const { lang, query } = LANGS[ext]
      const parser = new Parser()
      parser.setLanguage(lang)
      this.parsers.set(ext, { parser, query: new Parser.Query(lang, query) })
    }
    return this.parsers.get(ext)
  }

  // Working tree, not blobs, so the agent's uncommitted edits are indexed.
  // Reparses only files whose mtime moved; a stat per file per call is cheap
  // at the repo sizes this serves. Symlinks are skipped: a checkout must not
  // be able to point the index outside itself.
  refresh () {
    this.tracked = new Set(git(this.repo, 'ls-files', '-z').split('\0').filter(Boolean))
    const seen = new Set()
    let changed = false
    for (const file of this.tracked) {
      if (!LANGS[path.extname(file)]) continue
      let st
      try { st = fs.lstatSync(path.join(this.repo, file)) } catch { continue }
      if (!st.isFile()) continue
      seen.add(file)
      const cur = this.files.get(file)
      if (cur && cur.mtime === st.mtimeMs) continue
      this.files.set(file, { mtime: st.mtimeMs, ...this.parse(file) })
      changed = true
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        this.files.delete(file)
        changed = true
      }
    }
    if (changed) this.names = null
    const status = git(this.repo, 'status', '--porcelain=v2', '--branch', '-uno').split('\n')
    const oid = (status.find(l => l.startsWith('# branch.oid ')) || '').slice('# branch.oid '.length)
    this.head = oid.startsWith('(') ? 'none' : oid.slice(0, 7)
    this.dirty = status.some(l => l && !l.startsWith('#'))
    return this
  }

  parse (file) {
    const { parser, query } = this.parserFor(path.extname(file))
    const text = fs.readFileSync(path.join(this.repo, file), 'utf8')
    const tree = parser.parse(text)
    const defs = new Map()
    const refs = new Map()
    const own = new Set()
    for (const m of query.matches(tree.rootNode)) {
      const name = m.captures.find(c => c.name === 'name')
      const tag = m.captures.find(c => c.name !== 'name')
      if (!name || !tag) continue
      const node = tag.node
      if (tag.name.startsWith('definition.')) {
        // A method matches both the method and the function pattern on the
        // same node; the method pattern comes first in tags.scm and wins.
        if (defs.has(node.startIndex)) continue
        const nl = text.indexOf('\n', node.startIndex)
        defs.set(node.startIndex, {
          file,
          name: name.node.text,
          kind: kindOf(tag.name, node),
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          sig: text.slice(node.startIndex, nl < 0 ? node.endIndex : nl).trim().slice(0, 160)
        })
        // A definition's own name is not a use of it.
        own.add(`${name.node.startPosition.row + 1}:${name.node.text}`)
      } else {
        // One name on one line is one edge; the earlier, more specific
        // pattern (implementation, call) names it.
        const line = name.node.startPosition.row + 1
        const key = `${line}:${name.node.text}`
        if (!refs.has(key)) refs.set(key, { file, name: name.node.text, line, kind: tag.name.slice('reference.'.length) })
      }
    }
    const defList = [...defs.values()]
    const refList = [...refs.values()].filter(r => !own.has(`${r.line}:${r.name}`))
    for (const r of refList) r.in = enclosing(defList, r.line)
    const counts = new Map()
    for (const d of defList) counts.set(d.name, (counts.get(d.name) || 0) + 1)
    const dupes = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name))
    return { text, defs: defList, refs: refList, dupes }
  }

  * defs () {
    for (const f of this.files.values()) yield * f.defs
  }

  * refs () {
    for (const f of this.files.values()) yield * f.refs
  }

  count () {
    return [...this.defs()].length
  }

  // sym:<path>#<name>, with @<line> when the name repeats in the file.
  idOf (d) {
    return `sym:${d.file}#${d.name}${this.files.get(d.file).dupes.has(d.name) ? `@${d.line}` : ''}`
  }

  // An ambiguous name without its @line is nobody's symbol; search() prints
  // the exact ids.
  resolve (id) {
    const m = /^(?:sym:)?(.+?)#([^@]+)(?:@(\d+))?$/.exec(id)
    if (!m) return null
    const f = this.files.get(m[1])
    if (!f) return null
    const cands = f.defs.filter(d => d.name === m[2])
    if (m[3]) return cands.find(d => d.line === Number(m[3])) || null
    return cands.length === 1 ? cands[0] : null
  }

  lookup () {
    if (!this.names) {
      this.names = new Map()
      this.uses = new Map()
      for (const d of this.defs()) {
        if (!this.names.has(d.name)) this.names.set(d.name, [])
        this.names.get(d.name).push(d)
      }
      for (const r of this.refs()) {
        if (!this.uses.has(r.name)) this.uses.set(r.name, [])
        this.uses.get(r.name).push(r)
      }
    }
    return this
  }

  byName (name) {
    return this.lookup().names.get(name) || []
  }

  source (d) {
    const lines = this.files.get(d.file).text.split('\n').slice(d.line - 1, d.endLine)
    return lines.map((l, i) => `${d.line + i}: ${l}`).join('\n')
  }

  // Uses of a definition's name anywhere in the repo, each with the symbol
  // it sits in.
  refsTo (d) {
    return (this.lookup().uses.get(d.name) || []).filter(r => !(r.file === d.file && r.line >= d.line && r.line <= d.endLine))
  }

  // Definitions named inside a definition's body. A name defined in several
  // places lists every candidate; one hop of context is not the place to
  // guess.
  refsFrom (d) {
    const names = new Set(this.files.get(d.file).refs.filter(r => r.line >= d.line && r.line <= d.endLine).map(r => r.name))
    const out = []
    for (const name of names) out.push(...this.byName(name).filter(x => x !== d))
    return out
  }

  // Files holding a use of any name this file record defines.
  usersOf (f) {
    return [...new Set(f.defs.flatMap(d => (this.lookup().uses.get(d.name) || []).filter(r => r.file !== d.file).map(r => r.file)))]
  }

  // Any tracked regular file, parsed or not: a commit can implement a spec
  // through a config file or a doc, and an id must never reach outside the
  // checkout. Text is read on demand for a file the index does not parse.
  file (p) {
    if (!this.tracked.has(p)) return null
    const f = this.files.get(p)
    if (f) return f
    if (!regular(path.join(this.repo, p))) return null
    const repo = this.repo
    return { defs: [], refs: [], get text () { return fs.readFileSync(path.join(repo, p), 'utf8') } }
  }

  // Inbound reference counts, cross-file uses weighted above local ones, with a
  // boost for files in recent commits. ponytail: ref-count ranking; personalized
  // PageRank like aider/repomap.py if the pick is poor.
  ranked (recentFiles = new Set()) {
    const score = new Map()
    for (const r of this.refs()) {
      for (const d of this.byName(r.name)) {
        score.set(d, (score.get(d) || 0) + (d.file === r.file ? 0.5 : 1))
      }
    }
    return [...this.defs()]
      .map(d => ({ d, s: (score.get(d) || 0) * (recentFiles.has(d.file) ? 2 : 1) }))
      .sort((a, b) => b.s - a.s || a.d.file.localeCompare(b.d.file) || a.d.line - b.d.line)
  }
}

function enclosing (defs, line) {
  let best = null
  for (const d of defs) {
    if (line < d.line || line > d.endLine) continue
    if (!best || d.endLine - d.line < best.endLine - best.line) best = d
  }
  return best
}

module.exports = { Index, LANGS, git }
