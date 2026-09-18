'use strict'

function installNativeLinkLabels (md) {
  const parseLinkLabel = md.helpers.parseLinkLabel
  function nativeLabelRule (state, start, disableNested) {
    const previous = state.criticLinkLabel
    const enabled = state.src.charCodeAt(state.pos) !== 0x21
    const cache = state.cache
    const switchCache = state.env.native && !!previous !== enabled
    const nextKey = enabled ? 'criticLinkLabelCache' : 'criticRawCache'
    if (switchCache) {
      state[previous ? 'criticLinkLabelCache' : 'criticRawCache'] = cache
      state.cache = state[nextKey] || {}
    }
    state.criticLinkLabel = enabled
    try { return parseLinkLabel(state, start, disableNested) } finally {
      if (switchCache) {
        state[nextKey] = state.cache
        state.cache = cache
      }
      state.criticLinkLabel = previous
    }
  }
  md.helpers = Object.assign({}, md.helpers, {
    parseLinkLabel (state, start, disableNested) {
      return md.criticBoundaryParseLabel ? md.criticBoundaryParseLabel(state, start, disableNested, nativeLabelRule) : nativeLabelRule(state, start, disableNested)
    }
  })
}

function installBodyBoundaries (md, helpers, ancestorPrelude) {
  const markerRE = /\{!critic\d+:\d+ ?!\}/g
  const paragraphRule = md.block.ruler.__rules__.find(rule => rule.name === 'paragraph')
  const paragraph = paragraphRule.fn
  md.block.ruler.at('paragraph', (state, start, end, silent) => {
    const before = state.tokens.length
    const result = paragraph(state, start, end, silent)
    if (state.env.criticBoundaryProbe) return result
    const token = state.tokens.slice(before).find(token => token.type === 'inline')
    if (!token || !token.content.includes('{!critic')) return result
    if (!state.criticLineStarts) state.criticLineStarts = helpers.lineStarts(state.src)
    token.criticBodyContexts = new Map()
    for (let line = start; line < state.line; line++) {
      const from = state.criticLineStarts[line]
      const to = state.bMarks[line] + state.tShift[line]
      const content = state.src.slice(to, state.eMarks[line])
      let cursor = 0; let pipes = 0; let escaped = false; let anyPipe = false
      const leadingPipe = content.trimStart().startsWith('|')
      for (const match of content.matchAll(markerRE)) {
        for (; cursor < match.index; cursor++) {
          const ch = content.charAt(cursor)
          if (ch === '|') anyPipe = true
          if (ch === '|' && !escaped) pipes++
          escaped = ch === '\\'
        }
        token.criticBodyContexts.set(match[0], { prefix: state.src.slice(from, to), line, pipes, leadingPipe, anyPipe })
      }
    }
    return result
  }, { alt: paragraphRule.alt })
  function bodyEnd (marker, raw, context, node) {
    let prelude = ancestorPrelude({ token: { map: [context.line, context.line + 1] }, ancestors: node.ancestors })
    const sameDefinition = node.ancestors.find(node => node.token.type === 'dd_open' && node.token.map[0] === context.line)
    if (sameDefinition) {
      const prefix = sameDefinition.token.criticContainer.prefix
      const marker = /[:~][ \t]*$/.exec(prefix)
      if (marker) prelude += prefix.slice(0, marker.index) + 'context\n'
    }
    const lines = raw.split('\n', 3)
    const pipeCount = Math.min(context.pipes, (lines[1] || '').length + 3)
    const header = pipeCount ? (context.leadingPipe ? '|' : 'x|') + 'x|'.repeat(pipeCount - 1) + 'x' : context.anyPipe ? 'x\\|x' : ''
    const source = prelude + context.prefix + header + marker + raw
    const starts = helpers.lineStarts(source)
    const body = prelude.length + context.prefix.length + header.length + marker.length
    const tokens = []
    md.block.parse(source, md, { criticBoundaryProbe: true }, tokens)
    const stack = []
    for (const token of tokens) {
      if (token.nesting < 0) stack.pop()
      if (token.type === 'inline' && token.content.includes(marker)) {
        const mapped = token.map ? token : stack.slice().reverse().find(token => token.map)
        if (!mapped) return raw.length
        return Math.max(0, Math.min(raw.length, (starts[mapped.map[1]] || source.length) - body))
      }
      if (token.nesting > 0) stack.push(token)
    }
    return raw.length
  }
  return function prepare (token, node, markers) {
    const boundaries = []
    let delta = 0
    const lineMode = node && node.ancestors.some(n => /^(heading_open|th_open|td_open)$/.test(n.token.type))
    for (const match of token.content.matchAll(markerRE)) {
      const span = markers[match[0]]
      if (!span || span.type !== 'comment') continue
      const raw = helpers.normalizeSource(span.raw)
      const from = match.index + delta
      const body = from + match[0].length
      const context = token.criticBodyContexts && token.criticBodyContexts.get(match[0])
      const end = lineMode ? (raw.indexOf('\n') < 0 ? raw.length : raw.indexOf('\n') + 1) : context && node ? bodyEnd(match[0], raw, context, node) : raw.length
      if (end < raw.length) boundaries.push({ at: body + end, end: body + raw.length, span })
      if (token.content.slice(match.index + match[0].length, match.index + match[0].length + raw.length) !== raw) delta += raw.length
    }
    return boundaries
  }
}

function installInlineBoundaries (md) {
  const inlineParse = md.inline.parse
  md.inline.parse = function (source, parser, env, tokens) {
    env.criticBoundaryDepth = (env.criticBoundaryDepth || 0) + 1
    try { return inlineParse.call(this, source, parser, env, tokens) } finally { env.criticBoundaryDepth-- }
  }
  function makeContext (source, boundaries, index = 0) {
    const current = { source, boundaries, index, end: source.length, prefix: source }
    current.advance = offset => {
      while (current.index < boundaries.length && boundaries[current.index].end <= offset) current.index++
      current.end = current.index < boundaries.length ? boundaries[current.index].at : source.length
      current.prefix = source.slice(0, current.end)
    }
    current.advance(0)
    return current
  }
  function context (state) {
    if (!state.criticBoundary) state.criticBoundary = makeContext(state.src, state.env.criticBoundaries)
    return state.criticBoundary
  }
  const skipToken = md.inline.skipToken
  md.inline.skipToken = function (state) {
    if (!state.env.native || !state.env.criticBoundaries || state.env.criticBoundaryDepth !== 1) return skipToken.call(this, state)
    const current = context(state)
    if (!state.criticBoundarySkipCaches) state.criticBoundarySkipCaches = new Map()
    const key = current.index + ':' + !!state.criticLinkLabel + ':' + state.posMax
    if (!state.criticBoundarySkipCaches.has(key)) state.criticBoundarySkipCaches.set(key, {})
    const previous = state.cache
    const from = state.pos
    state.cache = state.criticBoundarySkipCaches.get(key)
    try {
      const result = skipToken.call(this, state)
      if (from < current.end && state.pos > current.end) {
        current.advance(state.pos)
        clearCaches(state)
      }
      return result
    } finally { state.cache = previous }
  }
  const cacheKeys = ['cache', 'backticks', 'backticksScanned', 'criticLinkLabelCache', 'criticRawCache', 'criticLookaheadBackticks', 'criticLookaheadScanned']
  function clearCaches (state) {
    for (const key of cacheKeys) state[key] = /Scanned$/.test(key) ? false : {}
  }
  md.criticBoundaryParseLabel = function (state, start, disableNested, parseLinkLabel) {
    if (!state.env.native || !state.env.criticBoundaries || state.env.criticBoundaryDepth !== 1) return parseLinkLabel(state, start, disableNested)
    if (state.src.charCodeAt(state.pos) === 0x21) {
      const raw = state.criticBoundaryRawLabel
      state.criticBoundaryRawLabel = true
      try { return parseLinkLabel(state, start, disableNested) } finally { state.criticBoundaryRawLabel = raw }
    }
    const current = context(state)
    const source = state.src
    const max = state.posMax
    const speculative = makeContext(current.source, current.boundaries, current.index)
    const caches = cacheKeys.map(key => state[key])
    state.criticBoundary = speculative
    state.criticBoundarySpeculating = (state.criticBoundarySpeculating || 0) + 1
    clearCaches(state)
    let end = -1
    try {
      end = parseLinkLabel(state, start, disableNested)
      return end
    } finally {
      state.criticBoundarySpeculating--
      state.criticBoundary = current
      for (let i = 0; i < cacheKeys.length; i++) state[cacheKeys[i]] = caches[i]
      state.src = end < 0 ? source : current.source.slice(0, Math.min(max, speculative.end))
      state.posMax = end < 0 ? max : Math.min(max, speculative.end)
    }
  }
  for (const rule of md.inline.ruler.__rules__.slice()) {
    const original = rule.fn
    md.inline.ruler.at(rule.name, (state, silent) => {
      if (!state.env.native || !state.env.criticBoundaries || state.env.criticBoundaryDepth !== 1) return original(state, silent)
      const current = context(state)
      if (state.pos >= current.end && current.end < current.source.length) {
        if (!silent) {
          if (!state.env.nativeDeferred) state.env.nativeDeferred = new Set()
          for (const match of current.source.slice(current.end).matchAll(/\{!critic\d+:\d+ ?!\}/g)) {
            const span = state.env.native[match[0]]
            if (span) state.env.nativeDeferred.add(span)
          }
        }
        state.pos = state.posMax
        return true
      }
      if (rule.name === 'critic_native') {
        if (silent && state.criticBoundaryRawLabel) return false
        const matched = original(state, silent)
        if (matched && (!silent || state.criticBoundarySpeculating) && state.pos > current.end) {
          current.advance(state.pos)
          clearCaches(state)
        }
        return matched
      }
      const source = state.src
      const max = state.posMax
      if (!['link', 'footnote_inline'].includes(rule.name)) {
        state.src = current.prefix
        state.posMax = Math.min(max, current.end)
      }
      try {
        const matched = original(state, silent)
        if (matched && ['link', 'footnote_inline'].includes(rule.name) && state.pos > current.end) {
          current.advance(state.pos)
          clearCaches(state)
        }
        return matched
      } finally {
        state.src = source
        state.posMax = max
      }
    }, { alt: rule.alt })
  }
}

module.exports = { installNativeLinkLabels, installBodyBoundaries, installInlineBoundaries }
