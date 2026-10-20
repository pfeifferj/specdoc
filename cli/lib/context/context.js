const { createHash } = require('crypto')
const { sections, bodyHash, sectionId, parseSectionId } = require('./sections')
const { rerank } = require('./laya')

const LIVE = new Set(['approved', 'implemented'])
const STOP = new Set('a an and are as at be by can change do does for from how i in into is it of on or our should spec specs that the their then this to use we what when where which with'.split(' '))
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim()
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const tokens = s => Math.ceil(s.length / 4)
const terms = s => [...new Set((s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length > 1 && !STOP.has(t)))]
const score = (text, words) => {
  const found = new Set(terms(text))
  return words.reduce((n, w) => n + Number(found.has(w)), 0)
}
const live = s => LIVE.has(s.status) && !s.superseded
const sourceName = (ctx, s) => ctx.specs.idOf(s)

function sectionContent (section) {
  return [...section.ancestors.map(a => a.text), section.text].filter(Boolean).join('\n')
}

function unit (ctx, doc, section, required, reason, taskWords, hash = bodyHash(doc.body)) {
  const id = sectionId(doc.id, hash, section.number)
  const text = sectionContent(section)
  const receipt = digest([
    'specdoc-context-v1', ctx.specs.url, ctx.index.repo, id, doc.title, doc.namespace,
    doc.status, doc.superseded, doc.dependsOn, doc.supersedes, doc.kind, doc.specPath, text
  ])
  const ownScore = score(section.text, taskWords)
  return { id, doc, section, hash, text, receipt, required, reason, ownScore,
    score: 3 * ownScore + 2 * score(section.heading, taskWords) + score(doc.title, taskWords) +
      0.5 * score(section.ancestors.map(a => a.text).join('\n'), taskWords) }
}

function describe (ctx, item, included = new Set(), documents = new Set()) {
  const { doc, section } = item
  const outside = ctx.specs.specs.some(s => s.id === doc.id) ? '' : '; outside scope'
  const ancestry = section.ancestors.length ? `; includes ${section.ancestors.map(a => `L${a.start}-${a.end}`).join(', ')}` : ''
  const source = documents.has(doc.id) ? [] : [
    `${sourceName(ctx, doc)}  ${oneLine(doc.title)}`,
    `${doc.status}${doc.superseded ? '; retired' : ''}${outside}; path: ${oneLine(doc.specPath) || '-'}; url: ${oneLine(doc.url) || '-'}`
  ]
  documents.add(doc.id)
  const text = [...section.ancestors, section].filter(range => {
    const key = JSON.stringify([doc.id, item.hash, range.start, range.end])
    if (included.has(key)) return false
    included.add(key)
    return true
  }).map(range => range.text).filter(Boolean).join('\n')
  return [
    ...source,
    `${item.id}  ${oneLine(section.label || section.heading || doc.title)}`,
    `L${section.start}-${section.end}${ancestry}; ${item.reason}`,
    `receipt: ${item.receipt}`,
    text
  ].filter(Boolean).join('\n')
}

async function getSection (ctx, { id, max_tokens }) {
  const ref = parseSectionId(id)
  if (!ref) throw new Error('invalid section id; use an id returned by context')
  const hit = ctx.specHit(ref.noteId)
  if (!hit) return null
  const doc = await ctx.specs.document(hit.s)
  if (doc.namespace !== hit.s.namespace || bodyHash(doc.body) !== ref.hash) {
    throw new Error('section source changed; run context again for current section ids')
  }
  const section = sections(doc.body).find(s => s.number === ref.number)
  if (!section) throw new Error('unknown section; run context again')
  const body = `source: board current published form; verify merged requirements for implementation acceptance.\n\n${describe(ctx, unit(ctx, doc, section, true, 'explicit section', []))}`
  const needed = tokens(`${ctx.header()}\n\n${body}`)
  if (needed > max_tokens) return `${id}\ncomplete section needs approximately ${needed} tokens including provenance; retry get with max_tokens=${needed}. Nothing from the section was delivered.${needed > 20000 ? ' This exceeds the tool limit; read the source document directly.' : ''}`
  return body
}

async function context (ctx, { task, anchors = [], seen = [], max_docs = 24, max_tokens = 1500 }, options = {}) {
  const readTimeout = AbortSignal.timeout(10000)
  const signal = options.signal ? AbortSignal.any([options.signal, readTimeout]) : readTimeout
  const taskWords = terms(task).slice(0, 80)
  const queue = new Map()
  const done = new Map()
  const gaps = []
  const requiredGaps = []
  const candidates = []
  const known = new Set(seen)
  const scoped = ctx.specs.scope !== 'all'
  let attempts = 0
  let bytes = 0
  let failed = 0
  let unresolvedDependencies = 0
  const add = (s, priority, reason, { explicit = false, whole = false, ref = null } = {}) => {
    const found = queue.get(s.id) || done.get(s.id)
    if (found) {
      found.priority = Math.min(found.priority, priority)
      found.explicit ||= explicit
      found.whole ||= whole
      if (ref) {
        if (found.refs.has(ref.number) && found.refs.get(ref.number) !== ref.hash) throw new Error('conflicting section revisions; run context again without stale anchors')
        found.refs.set(ref.number, ref.hash)
      }
      if (!found.reasons.includes(reason)) found.reasons.push(reason)
      return found
    }
    const entry = { s, priority, explicit, whole, refs: new Map(ref ? [[ref.number, ref.hash]] : []), reasons: [reason] }
    queue.set(s.id, entry)
    return entry
  }
  const linked = refs => {
    for (const ref of refs) {
      const s = ctx.specs.resolve(ref)
      if (s && live(s)) add(s, 2, 'file-level implementation history')
    }
  }
  for (const id of anchors) {
    if (id.startsWith('section:')) {
      const ref = parseSectionId(id)
      const hit = ref && ctx.specHit(ref.noteId)
      if (!hit) throw new Error(`unknown anchor ${id}; use an id returned by context`)
      add(hit.s, 0, 'explicit section', { explicit: true, ref })
      continue
    }
    const hit = ctx.resolve(id)
    if (!hit) throw new Error(`unknown anchor ${id}; search prints exact ids`)
    if (hit.type === 'spec') add(hit.s, 0, 'explicit spec', { explicit: true, whole: true })
    else if (hit.type === 'commit') linked(hit.c.refs.map(r => r.label))
    else {
      const file = hit.type === 'sym' ? hit.d.file : hit.file
      linked(ctx.log.forFile(file).flatMap(c => c.refs.map(r => r.label)))
    }
  }
  if (scoped) {
    for (const s of ctx.specs.specs.filter(live)) {
      add(s, s.kind === 'top-level' ? 1 : 3, s.kind === 'top-level' ? 'inherited top-level guidance' : 'task terms', { whole: s.kind === 'top-level' })
    }
  } else gaps.push('automatic discovery disabled: set SPECDOC_NAMESPACE; only explicit anchors and their scoped links are considered')

  const next = () => [...queue.values()].sort((a, b) => a.priority - b.priority ||
    score(`${b.s.title} ${b.s.abstract} ${b.s.area}`, taskWords) - score(`${a.s.title} ${a.s.abstract} ${a.s.area}`, taskWords) ||
    sourceName(ctx, a.s).localeCompare(sourceName(ctx, b.s)))
  const dependencies = entry => {
    entry.expanded = true
    for (const ref of entry.doc.dependsOn) {
      const s = ctx.specs.resolve(ref)
      if (!s) {
        unresolvedDependencies++
        requiredGaps.push(`unresolved or outside-scope dependency ${ref} from ${sourceName(ctx, entry.doc)}`)
      } else if (!live(s)) {
        unresolvedDependencies++
        requiredGaps.push(`dependency ${sourceName(ctx, s)} is ${s.superseded ? 'retired' : s.status}; inspect with get`)
      } else add(s, 1, `dependency of ${sourceName(ctx, entry.doc)}`, { whole: true })
    }
  }
  while (queue.size && attempts < max_docs && !signal.aborted && bytes < 2 * 1024 * 1024) {
    const ordered = next()
    const batch = ordered.filter(e => ordered[0].priority > 2 || e.priority === ordered[0].priority).slice(0, Math.min(4, max_docs - attempts))
    const allowance = Math.min(256 * 1024, Math.floor((2 * 1024 * 1024 - bytes) / batch.length))
    for (const entry of batch) {
      queue.delete(entry.s.id)
      done.set(entry.s.id, entry)
      attempts++
    }
    await Promise.all(batch.map(async entry => {
      try {
        const doc = await ctx.specs.document(entry.s, { signal, maxBytes: allowance })
        if (doc.namespace !== entry.s.namespace || (!entry.explicit && (!live(doc) || !ctx.specs.specs.some(s => s.id === doc.id)))) {
          throw new Error('source scope or lifecycle changed; refresh context before using it')
        }
        const parsed = sections(doc.body)
        for (const [number, hash] of entry.refs) {
          if (hash !== bodyHash(doc.body) || !parsed.some(s => s.number === number)) throw new Error('section source changed; run context again without the stale section anchor')
        }
        entry.doc = doc
        entry.sections = parsed
      } catch (e) {
        entry.error = true
        failed++
        entry.errorMessage = `${sourceName(ctx, entry.s)} unavailable: ${oneLine(e.message)}`
      }
    }))
    for (const entry of batch) bytes += entry.error ? allowance : entry.doc.bytes
    let expanded
    do {
      expanded = false
      for (const entry of done.values()) {
        if (!entry.doc || entry.error) continue
        if (entry.doc.kind === 'top-level' && !entry.explicit) {
          entry.whole = true
          entry.priority = Math.min(entry.priority, 1)
        }
        if (!entry.expanded && (entry.priority <= 2 || entry.sections.some(s =>
          score(sectionContent(s), taskWords) + score(`${entry.doc.title} ${s.heading}`, taskWords) > 0))) {
          dependencies(entry)
          expanded = true
        }
      }
    } while (expanded)
  }

  // A dependency discovered late can promote a document already scanned.
  for (const entry of done.values()) {
    if (!entry.doc || entry.error) continue
    const hash = bodyHash(entry.doc.body)
    for (const section of entry.sections) {
      const required = entry.whole || entry.refs.has(section.number)
      const item = unit(ctx, entry.doc, section, required, oneLine(entry.reasons.join('; ')), taskWords, hash)
      item.priority = entry.refs.has(section.number) ? 0 : entry.whole && entry.explicit ? 1 : 2
      item.evidence = section.label && item.ownScore > 0 ? 0 :
        item.ownScore > 0 || score(section.heading, taskWords) > 0 ? 1 : item.score > 0 ? 2 : 3
      if (required || item.score > 0) candidates.push(item)
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.evidence - b.evidence || b.score - a.score || a.id.localeCompare(b.id))
  const readDeadlineReached = signal.aborted
  const repeated = candidates.filter(c => known.has(c.receipt)).length
  const available = candidates.filter(c => !known.has(c.receipt))
  const optional = available.filter(c => !c.required)
  let ranking = { scores: null, reason: 'disabled', model: null }
  if (optional.length && !readDeadlineReached) {
    try {
      ranking = await (options.rerank || rerank)(task, optional.map(c => ({ id: c.id, text: c.text, heading: `${c.doc.title} > ${c.section.heading}` })), { signal: options.signal })
    } catch {
      ranking = { scores: null, reason: 'unavailable; lexical order retained', model: null }
    }
  }
  if (ranking.scores) {
    // Keep source priority and unscored candidates in place across the model batch.
    const groups = new Map()
    for (const item of optional.filter(c => ranking.scores.has(c.id))) {
      const key = `${item.priority}:${item.evidence}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    for (const group of groups.values()) group.sort((a, b) => ranking.scores.get(b.id) - ranking.scores.get(a.id) || b.score - a.score || a.id.localeCompare(b.id))
    for (let n = 0; n < available.length; n++) {
      const item = available[n]
      if (!item.required && ranking.scores.has(item.id)) available[n] = groups.get(`${item.priority}:${item.evidence}`).shift()
    }
  }
  const pending = next()
  const requiredPending = pending.filter(e => e.whole || e.refs.size)
  const requiredFailures = [...done.values()].filter(e => e.error && (e.whole || e.refs.size)).length
  for (const entry of done.values()) {
    if (entry.errorMessage) (entry.whole || entry.refs.size ? requiredGaps : gaps).push(entry.errorMessage)
  }
  if (readDeadlineReached) gaps.push('selection deadline reached')
  if (pending.length) gaps.push(`${pending.length} documents not read within source limits; raise max_docs or narrow anchors`)
  for (const entry of requiredPending.slice(0, 3)) requiredGaps.push(`required source not read: ${sourceName(ctx, entry.s)}; use get`)

  const intro = 'source: board current published form; verify merged requirements for implementation acceptance.\nSelected excerpts are not a complete conformance review; follow definitions, references and exceptions in the source. Shared ancestor text appears once per response.'
  const scoring = ranking.scores ? `laya: ${oneLine(ranking.model)}; ${oneLine(ranking.reason)}` : `ranking: lexical${ranking.reason === 'disabled' ? '' : `; ${oneLine(ranking.reason)}`}`
  const selected = []
  const omitted = []
  const summary = (items, missing) => {
    const requiredMissing = missing.filter(c => c.required).length + requiredPending.length + requiredFailures + unresolvedDependencies
    return `coverage: ${done.size - failed}/${attempts + pending.length} documents read; ${items.length} sections delivered, ${repeated} already held, ${missing.length} selected sections omitted; required gaps: ${requiredMissing}. ${scoring}`
  }
  const notices = [...requiredGaps, ...gaps].slice(0, 3).map(g => `gap: ${g.slice(0, 240)}`).join('\n')
  const trailer = missing => missing.length
    ? `omitted: ${missing.slice(0, 3).map(c => `${c.id}${c.required ? ' (required)' : ''}`).join(', ')}${missing.length > 3 ? `; ${missing.length - 3} more` : ''}\nExpand an id with get, or rerun context with receipts in seen to page through remaining sections.`
    : ''
  const render = (items, missing) => {
    const included = new Set()
    const documents = new Set()
    return [intro, summary(items, missing), notices, ...items.map(c => describe(ctx, c, included, documents)), trailer(missing)].filter(Boolean).join('\n\n')
  }
  const fits = text => tokens(`${ctx.header()}\n\n${text}`) <= max_tokens
  // Reserve the largest omission footer before admitting complete source units.
  const reserve = render([], available)
  let used = tokens(`${ctx.header()}\n\n${reserve}`)
  let included = new Set()
  let documents = new Set()
  for (const item of available) {
    const nextIncluded = new Set(included)
    const nextDocuments = new Set(documents)
    const cost = tokens(describe(ctx, item, nextIncluded, nextDocuments) + '\n\n')
    if (used + cost <= max_tokens) {
      selected.push(item)
      used += cost
      included = nextIncluded
      documents = nextDocuments
    } else omitted.push(item)
  }
  let body = render(selected, omitted)
  while (!fits(body) && selected.length) {
    omitted.unshift(selected.pop())
    body = render(selected, omitted)
  }
  if (!fits(body)) {
    body = `No excerpts delivered: provenance and omission details exceed max_tokens=${max_tokens}. Retry with a larger budget.\n${summary([], available)}\n${notices.slice(0, 400)}`
  }
  return body
}

module.exports = { context, getSection, sectionContent, terms }
