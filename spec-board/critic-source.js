'use strict'

const MarkdownIt = require('markdown-it')
const PDF_PATTERN = /{%pdf\s*([\d\D]*?)\s*%}/
const markerRE = /\{!critic\d+:\d+ ?!\}/g
const installBlockRecovery = require('./critic-context-block')
const { installNativeLinkLabels, installBodyBoundaries, installInlineBoundaries } = require('./critic-context-inline')

const md = new MarkdownIt({ html: true })
  .use(require('markdown-it-abbr'))
  .use(installNativeLinkLabels)
  .use(require('markdown-it-footnote'))
  .use(require('markdown-it-deflist'))
  .use(require('markdown-it-sub'))
  .use(require('markdown-it-sup'))
  .use(require('markdown-it-mathjax')())

md.inline.ruler.before('text', 'critic_source_pdf', (state, silent) => {
  if (!state.src.startsWith('{%pdf', state.pos)) return false
  const match = PDF_PATTERN.exec(state.src.slice(state.pos))
  if (!match || match.index !== 0) return false
  if (!silent) state.push('critic_source_pdf', '', 0).content = match[0]
  state.pos += match[0].length
  return true
})

md.inline.ruler.before('text', 'critic_source_suggestion', (state, silent) => {
  if (!state.env.criticSuggestions || !state.src.startsWith('{!critic', state.pos)) return false
  const match = /^\{!critic\d+:\d+ ?!\}/.exec(state.src.slice(state.pos))
  const span = match && state.env.criticSuggestions[match[0]]
  if (!span || span.type === 'comment') return false
  const raw = normalizeSource(span.raw)
  const from = state.pos + match[0].length
  if (from + raw.length > state.posMax || state.src.slice(from, from + raw.length) !== raw) return false
  if (!silent) state.push('critic_source_suggestion', '', 0).content = match[0]
  state.pos = from + raw.length
  return true
})

const sourceHelpers = { normalizeSource, lineStarts }
const { recover: recoverRoot, ancestorPrelude: continuationPrelude, certifyReferences } = installBlockRecovery(md, sourceHelpers, {
  expand,
  updateTags,
  parseInline (token, node, env, children) {
    env.criticBoundaries = prepareBoundaries(token, node, env.native)
    md.inline.parse(expand(token.content, env.native), md, env, children)
  }
})
const skipToken = md.inline.skipToken
md.inline.skipToken = function (state) {
  if (!state.env.native || state.criticLookingAhead) return skipToken.call(this, state)
  const backticks = state.backticks
  const scanned = state.backticksScanned
  state.backticks = state.criticLookaheadBackticks || {}
  state.backticksScanned = state.criticLookaheadScanned || false
  state.criticLookingAhead = true
  try { return skipToken.call(this, state) } finally {
    state.criticLookaheadBackticks = state.backticks
    state.criticLookaheadScanned = state.backticksScanned
    state.backticks = backticks
    state.backticksScanned = scanned
    state.criticLookingAhead = false
  }
}
function updateTags (tags, token) {
  if (token.type !== 'html_inline') return
  const tag = /^<(\/?)(code|pre|kbd|samp|script|style|textarea)(?:\s[^>]*|\s*)>/i.exec(token.content)
  if (!tag) return
  if (tag[1]) {
    const at = tags.lastIndexOf(tag[2].toLowerCase())
    if (at !== -1) tags.splice(at)
  } else if (!/\/>$/.test(token.content)) tags.push(tag[2].toLowerCase())
}
md.inline.ruler.before('text', 'critic_native', (state, silent) => {
  if ((silent && !state.criticLinkLabel) || !state.env.native || !state.src.startsWith('{!critic', state.pos)) return false
  const match = /^\{!critic\d+:\d+ ?!\}/.exec(state.src.slice(state.pos))
  const span = match && state.env.native[match[0]]
  if (!span) return false
  if (!state.criticNativeTags) state.criticNativeTags = { tags: (state.env.nativeTags || []).slice(), at: 0 }
  const tags = state.criticNativeTags
  while (tags.at < state.tokens.length) updateTags(tags.tags, state.tokens[tags.at++])
  if (tags.tags.length) return false
  const raw = normalizeSource(span.raw)
  const from = state.pos + match[0].length
  if (from + raw.length > state.posMax || state.src.slice(from, from + raw.length) !== raw) return false
  if (!silent) state.push('critic_native', '', 0).content = match[0]
  state.pos = from + raw.length
  return true
})
const footnoteRefRule = md.inline.ruler.__rules__.find(rule => rule.name === 'footnote_ref')
const footnoteRef = footnoteRefRule.fn
md.inline.ruler.at('footnote_ref', (state, silent) => {
  const result = footnoteRef(state, silent)
  if (result && !silent && state.env.criticFootnoteAudit) {
    const token = state.tokens[state.tokens.length - 1]
    state.env.criticFootnoteEdges.push([state.env.criticFootnoteOwner, token.meta.label])
  }
  return result
}, { alt: footnoteRefRule.alt })
const prepareBoundaries = installBodyBoundaries(md, sourceHelpers, continuationPrelude)
const originalInlineCore = md.core.ruler.__rules__.find(rule => rule.name === 'inline').fn
md.core.ruler.at('inline', state => {
  if (!state.env.criticAnalysis) return originalInlineCore(state)
  const previousNative = state.env.native
  const previousSuggestions = state.env.criticSuggestions
  state.env.native = previousSuggestions
  state.env.criticSuggestions = undefined
  try {
    const nodes = new Map(state.env.sourceGroups.nodes.map(node => [node.token, node]))
    const owners = []
    for (const token of state.tokens) {
      if (token.type === 'footnote_reference_open') owners.push(token.meta.label)
      if (token.type === 'footnote_reference_close') owners.pop()
      state.env.criticFootnoteOwner = owners.length ? owners[owners.length - 1] : null
      if (token.type === 'inline') {
        state.env.criticBoundaries = prepareBoundaries(token, nodes.get(token), state.env.native)
        md.inline.parse(expand(token.content, state.env.native), state.md, state.env, token.children)
      }
    }
  } finally {
    state.env.criticBoundaries = undefined
    state.env.native = previousNative
    state.env.criticSuggestions = previousSuggestions
  }
})
function expand (content, markers, selected) {
  return content.replace(markerRE, (marker, offset) => {
    const span = markers[marker]
    if (!span || span.type !== 'comment' || (selected && !selected.has(marker))) return marker
    const raw = normalizeSource(span.raw)
    return content.startsWith(raw, offset + marker.length) ? marker : marker + raw
  })
}
function nativeCandidates (text, candidates) {
  const fm = frontmatterRange(text)
  let spans = candidates.filter(span => !escapedAt(text, span.from) && !(fm && span.from < fm[1]))
  function unusedRejections (unused) {
    const blocked = blockedFootnotes(text, spans)
    const rejected = new Set([...unused].filter(span => blocked.has(span)))
    // Restoring a body can create the reference that activates its own note.
    // Settle the first unused body before reconsidering later notes.
    if (!rejected.size) rejected.add(spans.find(span => unused.has(span)))
    return rejected
  }
  for (let pass = 0; spans.length && pass < candidates.length + 1; pass++) {
    const projection = projectComments(text, spans, true)
    let source = projection.source
    const front = frontmatterRange(source)
    if (front) source = source.slice(0, front[1]).replace(/[^\r\n]/g, ' ') + source.slice(front[1])
    const env = { criticSuggestions: projection.markers, criticAnalysis: true }
    const tokens = md.parse(source, env)
    const whole = recoverRoot(expand(source, projection.markers), projection.markers, new Set(Object.keys(projection.markers)), env)
    if (whole && whole.reject.size) {
      spans = spans.filter(span => !whole.reject.has(span))
      continue
    }
    if (whole && whole.complete) {
      if (whole.unusedFootnoteReject.size) {
        const rejected = unusedRejections(whole.unusedFootnoteReject)
        spans = spans.filter(span => !rejected.has(span))
        continue
      }
      return validate(text, spans)
    }
    const accepted = new Set()
    const seen = new Set()
    const reject = new Set()
    const unusedFootnoteReject = new Set(whole ? whole.unusedFootnoteReject : [])
    const starts = lineStarts(source)
    const literalTags = []
    const inlineEnv = Object.assign({}, env, { criticSuggestions: undefined, native: projection.markers, nativeTags: literalTags })
    if (env.footnotes) inlineEnv.footnotes = JSON.parse(JSON.stringify(env.footnotes))
    const sourceNodes = new Map(env.sourceGroups.nodes.map(node => [node.token, node]))
    for (const token of tokens) {
      if (token.type !== 'inline') continue
      const children = []
      inlineEnv.criticBoundaries = prepareBoundaries(token, sourceNodes.get(token), projection.markers)
      md.inline.parse(expand(token.content, projection.markers), md, inlineEnv, children)
      for (const child of children) {
        updateTags(literalTags, child)
        if (!literalTags.length && child.type === 'critic_native') accepted.add(projection.markers[child.content])
      }
      for (const match of token.content.matchAll(markerRE)) {
        const span = projection.markers[match[0]]
        if (span) seen.add(span)
      }
      // A deferred closing tag can change later footnotes in rendered order.
      // Restore a known literal owner before judging those later tokens.
      if (inlineEnv.nativeDeferred && inlineEnv.nativeDeferred.size &&
        [...seen].some(span => !accepted.has(span) && !inlineEnv.nativeDeferred.has(span))) break
    }
    for (const span of seen) if (!accepted.has(span) && !(inlineEnv.nativeDeferred && inlineEnv.nativeDeferred.has(span))) reject.add(span)
    const groups = new Map()
    const unused = new Set()
    function selectGroup (node, selected) {
      const existing = groups.get(node) || new Set()
      for (const key of selected) existing.add(key)
      groups.set(node, existing)
    }
    for (const node of env.sourceGroups.nodes) {
      const token = node.token
      if (/^(fence|code_block|html_block)$/.test(token.type)) {
        const selected = [...(token.content + '\n' + token.info).matchAll(markerRE)].map(m => m[0]).filter(key => projection.markers[key])
        if (!selected.length) continue
        const owner = node.ancestors.slice().reverse().find(n => n.token.type === 'list_item_open') || node.ancestors[0] || node
        selectGroup(owner, selected)
      }
      if (token.type === 'footnote_reference_open' && (!env.footnotes || env.footnotes.refs[':' + token.meta.label] < 0)) {
        unused.add(token.meta.label)
        const part = source.slice(starts[token.map[0]], starts[token.map[1]] || source.length)
        selectGroup(node, [...part.matchAll(markerRE)].map(m => m[0]).filter(key => projection.markers[key]))
      }
    }
    for (const [group, selected] of groups) {
      if (!selected.size || !group.token.map) continue
      const map = group.token.map
      const from = starts[map[0]]
      const to = starts[map[1]] || source.length
      const prelude = continuationPrelude(group)
      const raw = expand(prelude + source.slice(from, to), projection.markers, selected)
      if (!prelude && /^(fence|code_block|html_block)$/.test(group.token.type)) {
        const recovered = recoverRoot(raw, projection.markers, selected, env)
        if (recovered && recovered.complete) {
          for (const span of recovered.reject) reject.add(span)
          for (const span of recovered.unusedFootnoteReject) unusedFootnoteReject.add(span)
          continue
        }
      }
      const rawEnv = {}
      md.parse(raw, rawEnv)
      const rawStarts = lineStarts(raw)
      const ranges = rawEnv.sourceGroups.nodes.map(n => n.token)
        .filter(t => t.map && (/^(fence|code_block|html_block)$/.test(t.type) || (t.type === 'footnote_reference_open' && unused.has(t.meta.label))))
        .map(t => ({ from: rawStarts[t.map[0]], to: rawStarts[t.map[1]] || raw.length, unused: t.type === 'footnote_reference_open' }))
        .sort((a, b) => a.from - b.from)
      let rangeIndex = 0
      let literalEnd = 0
      let unusedEnd = 0
      const boundaries = [...new Set(rawEnv.sourceGroups.nodes.flatMap(n => n.token.map ? n.token.map.map(line => rawStarts[line] || raw.length) : []))].sort((a, b) => a - b)
      for (const match of raw.matchAll(markerRE)) {
        if (!selected.has(match[0])) continue
        while (rangeIndex < ranges.length && ranges[rangeIndex].from <= match.index) {
          const range = ranges[rangeIndex++]
          if (range.unused) unusedEnd = Math.max(unusedEnd, range.to)
          else literalEnd = Math.max(literalEnd, range.to)
        }
        if (match.index >= Math.max(literalEnd, unusedEnd)) {
          const end = match.index + match[0].length + normalizeSource(projection.markers[match[0]].raw).length
          let lo = 0
          let hi = boundaries.length
          while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (boundaries[mid] <= match.index) lo = mid + 1
            else hi = mid
          }
          if (lo < boundaries.length && boundaries[lo] < end) break
          continue
        }
        const rejected = match.index < literalEnd ? reject : unusedFootnoteReject
        rejected.add(projection.markers[match[0]])
      }
    }
    let rejected = reject
    if (!reject.size && unusedFootnoteReject.size) {
      rejected = unusedRejections(unusedFootnoteReject)
    }
    const keep = spans.filter(span => !rejected.has(span))
    if (keep.length === spans.length) return validate(text, spans.filter(span => accepted.has(span)))
    spans = keep
  }
  return spans
}
for (const name of ['sup', 'sub']) {
  const original = md.inline.ruler.__rules__.find(rule => rule.name === name)
  const rule = original.fn
  md.inline.ruler.at(name, (state, silent) => !state.env.criticCompact && rule(state, silent), { alt: original.alt })
}
md.inline.ruler.before('critic_source_suggestion', 'critic_validation', (state, silent) => {
  if (!state.env.criticValidation || !state.src.startsWith('{!critic', state.pos)) return false
  const match = /^\{!critic\d+:\d+ ?!\}/.exec(state.src.slice(state.pos))
  const span = match && state.env.criticSuggestions[match[0]]
  if (!span) return false
  let end = state.pos + match[0].length
  if (end > state.posMax) return false
  if (span.type !== 'comment') {
    const raw = normalizeSource(span.raw)
    if (end + raw.length > state.posMax || state.src.slice(end, end + raw.length) !== raw) return false
    end += raw.length
  }
  if (!silent) state.push('critic_validated', '', 0).content = match[0]
  state.pos = end
  return true
})

installInlineBoundaries(md)

function validate (text, initial) {
  let eligible = initial
  function markers (source, suggestions, scripts = true) {
    const found = new Set()
    const tags = []
    for (const token of md.parse(source, { criticSuggestions: suggestions, criticValidation: true, criticCompact: !scripts })) {
      if (token.type !== 'inline') continue
      let script = 0
      for (const child of token.children || []) {
        updateTags(tags, child)
        if (/^(sup|sub)_open$/.test(child.type)) script++
        if (/^(sup|sub)_close$/.test(child.type)) script--
        if (tags.length || (scripts && script) || child.type !== 'critic_validated') continue
        for (const match of child.content.matchAll(markerRE)) {
          found.add(match[0])
        }
      }
    }
    return found
  }
  while (eligible.length) {
    const p = projectComments(text, eligible, true)
    const front = frontmatterRange(p.source)
    if (front) p.source = p.source.slice(0, front[1]).replace(/[^\r\n]/g, ' ') + p.source.slice(front[1])
    const active = markers(p.source, p.markers)
    const compactMap = Object.create(null)
    for (const key of Object.keys(p.markers)) compactMap[key.replace(' !}', '!}')] = p.markers[key]
    const compactSource = p.source.replace(markerRE, key => p.markers[key] ? key.replace(' !}', '!}') : key)
    const compact = compactSource === p.source ? active : markers(compactSource, compactMap, false)
    const kept = Object.keys(p.markers).filter(key => active.has(key) && compact.has(key.replace(' !}', '!}'))).map(key => p.markers[key])
    if (kept.length === eligible.length) return eligible
    eligible = kept
  }
  return eligible
}
function blockedFootnotes (text, spans) {
  const blocked = new Set()
  if (!spans.length || !text.includes('[^')) return blocked
  const projection = projectComments(text, spans, true)
  const front = frontmatterRange(projection.source)
  if (front) projection.source = projection.source.slice(0, front[1]).replace(/[^\r\n]/g, ' ') + projection.source.slice(front[1])
  const env = { criticSuggestions: projection.markers, criticAnalysis: true, criticFootnoteAudit: true, criticFootnoteEdges: [] }
  md.parse(projection.source, env)
  const definitions = env.sourceGroups.nodes.filter(node => node.token.type === 'footnote_reference_open' && node.token.map)
  if (!definitions.length) return blocked
  const starts = lineStarts(projection.source)
  const labels = new Set(definitions.map(node => node.token.meta.label))
  const owners = new Map()
  for (const node of definitions) {
    const map = node.token.map
    const part = projection.source.slice(starts[map[0]], starts[map[1]] || projection.source.length)
    for (const match of part.matchAll(markerRE)) if (projection.markers[match[0]]) owners.set(match[0], node.token.meta.label)
  }
  if (!owners.size) return blocked
  const reachable = new Set()
  const edges = new Map()
  for (const [owner, label] of env.criticFootnoteEdges) {
    if (owner === null) reachable.add(label)
    else {
      if (!edges.has(owner)) edges.set(owner, new Set())
      edges.get(owner).add(label)
    }
  }
  const fenceProofs = new Map()
  for (;;) {
    for (const label of reachable) for (const target of edges.get(label) || []) reachable.add(target)
    const before = reachable.size
    const rawEnv = {}
    const rawMarkers = new Set([...owners].filter(([, owner]) => !reachable.has(owner)).map(([marker]) => marker))
    if (!rawMarkers.size) break
    const rawSource = expand(projection.source, projection.markers, rawMarkers)
    md.parse(rawSource, rawEnv)
    for (const note of (rawEnv.footnotes && rawEnv.footnotes.list) || []) if (note.label !== undefined && labels.has(note.label)) reachable.add(note.label)
    if (reachable.size === before) break
    certifyReferences(rawSource, projection.markers, rawMarkers, { owners, reachable, edges, labels, rawEnvironment: rawEnv, proofs: fenceProofs })
  }
  for (const [marker, owner] of owners) if (!reachable.has(owner)) blocked.add(projection.markers[marker])
  return blocked
}
function renderedSpans (text, candidates) {
  let pending = candidates
  while (pending.length) {
    const admitted = nativeCandidates(text, pending)
    const blocked = blockedFootnotes(text, admitted)
    if (!blocked.size) return admitted
    pending = admitted.filter(span => !blocked.has(span))
  }
  return []
}

function normalizeSource (text) {
  return text.replace(/\r\n?|\0/g, match => match === '\0' ? '\uFFFD' : '\n')
}

function markerText (prefix, index, raw) {
  // Sup/subscript rules reject unescaped whitespace. Preserve that boundary
  // even when an opaque comment replaces several paragraphs with one marker.
  return prefix + index + (/(^|[^\\])(\\\\)*\s/.test(raw) ? ' ' : '') + '!}'
}

function lineStarts (text) {
  const starts = [0]
  const breaks = /\r\n|\r|\n/g
  let match
  while ((match = breaks.exec(text))) starts.push(match.index + match[0].length)
  return starts
}

function lineAt (starts, offset) {
  let lo = 0
  let hi = starts.length
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid
  }
  return lo
}

function frontmatterRange (text) {
  const match = /^(?:\uFEFF)?---[^\S\r\n]*(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)(?:---|\.\.\.)[^\S\r\n]*(?:(?:\r\n|\r|\n)|$)/.exec(text)
  return match ? [0, match[0].length] : null
}

function literalRanges (text) {
  const starts = lineStarts(text)
  const ranges = md.parse(text, {}).filter(token =>
    token.map && /^(?:fence|code_block|html_block)$/.test(token.type)
  ).map(token => [starts[token.map[0]], starts[token.map[1]] || text.length])
  const frontmatter = frontmatterRange(text)
  if (frontmatter) ranges.push(frontmatter)
  return ranges
}

function markerPrefix (text) {
  let n = 0
  while (text.includes('{!critic' + n + ':')) n++
  return '{!critic' + n + ':'
}

function escapedAt (text, offset) {
  let slashes = 0
  while (offset > 0 && text[--offset] === '\\') slashes++
  return slashes % 2 === 1
}

function projectComments (text, spans, includeSuggestions = false) {
  const prefix = markerPrefix(text)
  const markers = Object.create(null)
  const pieces = []
  let source = ''
  let pos = 0
  function append (raw, from, replacement) {
    if (replacement) {
      pieces.push({ from: source.length, to: source.length + replacement.length, original: from, end: from + raw.length, replacement: true })
      source += replacement
      return
    }
    const breaks = /\r\n|\r|\n|\0/g
    let last = 0
    let match
    while ((match = breaks.exec(raw))) {
      const chunk = raw.slice(last, match.index)
      pieces.push({ from: source.length, to: source.length + chunk.length, original: from + last })
      source += chunk
      pieces.push({ from: source.length, to: source.length + 1, original: from + match.index, end: from + match.index + match[0].length, replacement: true })
      source += match[0] === '\0' ? '\uFFFD' : '\n'
      last = match.index + match[0].length
    }
    pieces.push({ from: source.length, to: source.length + raw.length - last, original: from + last })
    source += raw.slice(last)
  }
  spans.filter(span => span.type === 'comment' || includeSuggestions).forEach((span, i) => {
    append(text.slice(pos, span.from), pos)
    const marker = markerText(prefix, i, span.raw)
    markers[marker] = span
    if (span.type === 'comment') {
      append(span.raw, span.from, marker)
    } else {
      append('', span.from, marker)
      append(span.raw, span.from)
    }
    pos = span.to
  })
  append(text.slice(pos), pos)
  const nonempty = pieces.filter(piece => piece.to > piece.from)
  function originalOffset (offset, end = false) {
    if (offset >= source.length) return text.length
    let lo = 0
    let hi = nonempty.length
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1
      if (nonempty[mid].from <= offset) lo = mid
      else hi = mid
    }
    const piece = nonempty[lo]
    if (!piece) return 0
    if (piece.replacement) return end ? piece.end : piece.original
    return piece.original + offset - piece.from
  }
  const originalStarts = lineStarts(text)
  const generatedStarts = lineStarts(source)
  const originalLine = line => line >= generatedStarts.length
    ? originalStarts.length
    : lineAt(originalStarts, originalOffset(generatedStarts[line]))
  return { source, markers, prefix, originalOffset, originalLine }
}

module.exports = { lineStarts, lineAt, literalRanges, renderedSpans, projectComments, normalizeSource, PDF_PATTERN }
