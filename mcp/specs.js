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
  constructor (url, namespaces = [], strict = namespaces.length > 0) {
    this.url = url.replace(/\/$/, '')
    this.namespaces = namespaces
    this.strict = strict
    this.all = null
    this.specs = []
    this.scope = 'all'
    this.error = null
    this.at = null
    this.fetchedAt = null
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
        let stale = false
        let at = null
        for (let page = 0; ; page++) {
          if (page >= PAGE_CAP) throw new Error(`/api/specs: more than ${PAGE_CAP} pages`)
          const r = await this.fetchJson(`/api/specs?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
          if (!Array.isArray(r.body.specs)) throw new Error('/api/specs: no specs array')
          all.push(...r.body.specs.map(normalize))
          stale ||= r.body.stale === true
          const observed = typeof r.body.at === 'string' ? Date.parse(r.body.at) : NaN
          if (Number.isFinite(observed) && (at === null || observed < at)) at = observed
          maxAge = r.maxAge
          cursor = typeof r.body.next === 'string' ? r.body.next : ''
          if (!cursor) break
        }
        this.all = all
        this.at = at === null ? null : new Date(at).toISOString()
        this.error = stale ? `board reported stale data${this.at ? ' from ' + this.at : ''}` : null
        this.fetchedAt = Date.now()
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

  // Inferred repositories may fall back to the corpus. An explicit selection
  // keeps its scope even when no matching specs have reached the board yet.
  select () {
    const mine = this.namespaces.length ? this.all.filter(s => this.namespaces.includes(s.namespace)) : []
    this.specs = this.strict || mine.length ? mine : this.all
    this.scope = this.strict || mine.length ? this.namespaces.join(',') || 'none' : 'all'
    this.byKey = this.index(this.specs)
    // The whole corpus, so an explicit reference outside the scope still has a
    // destination; nothing built from it feeds search or the reverse edges.
    this.byAnyKey = this.index(this.all)
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

  index (list) {
    const m = new Map()
    for (const s of list) {
      m.set(s.id, s)
      if (s.alias) m.set(s.alias, s)
      if (s.pr) {
        m.set(this.label(s), s)
        // A bare number shared by two namespaces names neither.
        m.set(`#${s.pr}`, m.has(`#${s.pr}`) ? null : s)
      }
    }
    return m
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
    return this.lookup(this.byKey, id)
  }

  outside (id) {
    return this.resolve(id) ? null : this.lookup(this.byAnyKey, id)
  }

  lookup (map, id) {
    const ref = specRef(String(id).replace(/^spec:/, ''), null)
    return (ref && map.get(key(ref))) || null
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
    superseded: !!s.superseded,
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(oneLine) : [],
    supersedes: oneLine(s.supersedes) || null
  }
}

module.exports = { Specs }
