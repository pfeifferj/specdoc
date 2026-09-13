const { specRef } = require('../spec-board/refs')

const DEFAULT_MAX_AGE = 60
const PAGE_CAP = 100
const BODY_CAP = 50 * 1024 * 1024
const key = ref => ref.noteId || `${ref.ns || ''}#${ref.n}`

// The spec side of the graph is the board's public read api; nothing here
// touches its database. The whole corpus is fetched (it is small) and
// refetched when the board's own Cache-Control lapses, which tracks its poll
// interval. A fetch failure keeps serving what was last read.
class Specs {
  constructor (url, namespaces = []) {
    this.url = url.replace(/\/$/, '')
    this.namespaces = namespaces
    this.all = null
    this.specs = []
    this.scope = 'all'
    this.error = null
    this.expires = 0
  }

  async fetchJson (path) {
    const res = await fetch(`${this.url}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    const text = await res.text()
    if (text.length > BODY_CAP) throw new Error(`${path}: response too large`)
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '')
    return { body: JSON.parse(text), maxAge: m ? Number(m[1]) : DEFAULT_MAX_AGE }
  }

  async load () {
    if (Date.now() >= this.expires) {
      try {
        const all = []
        let cursor = ''
        let maxAge = DEFAULT_MAX_AGE
        for (let page = 0; ; page++) {
          if (page >= PAGE_CAP) throw new Error(`/api/specs: more than ${PAGE_CAP} pages`)
          const r = await this.fetchJson(`/api/specs?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
          if (!Array.isArray(r.body.specs)) throw new Error('/api/specs: no specs array')
          all.push(...r.body.specs.map(normalize))
          maxAge = r.maxAge
          cursor = typeof r.body.next === 'string' ? r.body.next : ''
          if (!cursor) break
        }
        this.all = all
        this.error = null
        this.expires = Date.now() + maxAge * 1000
      } catch (e) {
        if (!this.all) throw e
        this.error = e.message
        this.expires = Date.now() + 30 * 1000
      }
    }
    this.select()
    return this
  }

  // The configured namespaces, or every namespace when they hold nothing: a
  // checkout that names no spec repo yet still gets to read the board. The
  // reverse edges are resolved here once, so a lookup is a map get.
  select () {
    const mine = this.namespaces.length ? this.all.filter(s => this.namespaces.includes(s.namespace)) : []
    this.specs = mine.length ? mine : this.all
    this.scope = mine.length ? this.namespaces.join(',') : 'all'
    this.byKey = new Map()
    for (const s of this.specs) {
      this.byKey.set(s.id, s)
      if (s.alias) this.byKey.set(s.alias, s)
      if (s.pr) {
        this.byKey.set(this.label(s), s)
        // A bare number shared by two namespaces in scope names neither.
        this.byKey.set(`#${s.pr}`, this.byKey.has(`#${s.pr}`) ? null : s)
      }
    }
    this.rev = new Map()
    const add = (target, field, s) => {
      const t = target && this.resolve(target)
      if (!t) return
      if (!this.rev.has(t)) this.rev.set(t, { neededBy: [], supersededBy: [] })
      this.rev.get(t)[field].push(s)
    }
    for (const s of this.specs) {
      for (const l of s.dependsOn) add(l, 'neededBy', s)
      add(s.supersedes, 'supersededBy', s)
    }
  }

  async body (s) {
    const r = await this.fetchJson(`/api/specs/${encodeURIComponent(s.id)}`)
    return typeof r.body.body === 'string' ? r.body.body : ''
  }

  // The label the board itself uses in dependsOn/supersedes: ns#N when
  // numbered, the note shortid otherwise.
  label (s) {
    return s.pr ? `${s.namespace}#${s.pr}` : s.id
  }

  idOf (s) {
    return `spec:${this.label(s)}`
  }

  // Takes every spelling the board does: owner/repo#N, bare #N or N (any
  // namespace), a shortid, an alias.
  resolve (id) {
    const ref = specRef(String(id).replace(/^spec:/, ''), null)
    return (ref && this.byKey.get(key(ref))) || null
  }

  neededBy (s) {
    return this.rev.get(s)?.neededBy || []
  }

  supersededBy (s) {
    return this.rev.get(s)?.supersededBy || []
  }

  search (q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return this.specs.filter(s => {
      const hay = `${s.title} ${s.abstract} ${this.label(s)}`.toLowerCase()
      return words.every(w => hay.includes(w))
    })
  }
}

// The fields that end up in single-line output or drive a lookup, held to
// the shape the tools assume whatever board version sent them.
const oneLine = v => String(v ?? '').replace(/\s+/g, ' ').trim()
function normalize (s) {
  return {
    ...s,
    title: oneLine(s.title),
    abstract: oneLine(s.abstract),
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(oneLine) : [],
    supersedes: oneLine(s.supersedes) || null
  }
}

module.exports = { Specs }
