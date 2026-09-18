'use strict'

module.exports = function installBlockRecovery (md, helpers, { expand, updateTags, parseInline }) {
  const markerRE = /\{!critic\d+:\d+ ?!\}/g
  const fenceRule = md.block.ruler.__rules__.find(rule => rule.name === 'fence')
  const fence = fenceRule.fn
  md.block.ruler.at('fence', (state, startLine, endLine, silent) => {
    const getLines = state.getLines
    let bodyEnd
    state.getLines = function (...args) {
      bodyEnd = args[1]
      return getLines.apply(this, args)
    }
    let result
    try { result = fence(state, startLine, endLine, silent) } finally { state.getLines = getLines }
    if (result && !silent) {
      const token = state.tokens[state.tokens.length - 1]
      token.criticUnclosedFence = bodyEnd === state.line && state.line >= endLine && state.blkIndent === 0
    }
    return result
  }, { alt: fenceRule.alt.slice() })
  const referenceBlockRule = md.block.ruler.__rules__.find(rule => rule.name === 'reference')
  const referenceBlock = referenceBlockRule.fn
  md.block.ruler.at('reference', (state, startLine, endLine, silent) => {
    const result = referenceBlock(state, startLine, endLine, silent)
    if (result && !silent) {
      if (!state.env.criticReferenceRanges) state.env.criticReferenceRanges = []
      state.env.criticReferenceRanges.push([state.bMarks[startLine], state.bMarks[state.line] || state.src.length])
    }
    return result
  }, { alt: referenceBlockRule.alt.slice() })
  function intersectsBody (bodies, from, to) {
    let lo = 0
    let hi = bodies.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bodies[mid].to <= from) lo = mid + 1
      else hi = mid
    }
    return lo < bodies.length && bodies[lo].from < to
  }
  const footnoteRule = md.block.ruler.__rules__.find(rule => rule.name === 'footnote_def')
  if (footnoteRule) {
    const footnote = footnoteRule.fn
    md.block.ruler.at('footnote_def', (state, startLine, endLine, silent) => {
      const before = state.tokens.length
      const result = footnote(state, startLine, endLine, silent)
      if (result && !silent) {
        state.tokens[before].map = [startLine, state.line]
        if (state.criticRecoveryRead) state.tokens[before].criticReadTo = state.criticRecoveryRead.dependency
      }
      return result
    }, { alt: footnoteRule.alt.slice() })
  }
  md.core.ruler.after('block', 'critic_block_groups', state => {
    state.env.sourceGroups = groupTokens(state.tokens)
  })
  // A failed reference or setext rule can read past the token eventually
  // produced by another rule. Preserve that lookahead when certifying a window.
  for (const rule of md.block.ruler.__rules__.slice()) {
    const parse = rule.fn
    md.block.ruler.at(rule.name, (state, startLine, endLine, silent) => {
      if (!state.criticRecoveryReads) return parse(state, startLine, endLine, silent)
      const previous = state.criticRecoveryRead
      const level = state.level
      const dependency = Math.max(startLine, state.criticRecoveryReads.get(level) || 0, previous ? previous.dependency : 0)
      const frame = { line: dependency, dependency }
      state.criticRecoveryRead = frame
      try {
        return parse(state, startLine, endLine, silent)
      } finally {
        state.criticRecoveryRead = previous
        if (previous) previous.line = Math.max(previous.line, frame.line)
        if (!silent) state.criticRecoveryReads.set(level, frame.line)
      }
    }, { alt: rule.alt.slice() })
  }
  const containerTypes = new Set(['blockquote_open', 'list_item_open', 'footnote_reference_open', 'dd_open'])
  const blockTokenize = md.block.tokenize
  md.block.tokenize = function (state, startLine, endLine, ...args) {
    const token = state.tokens[state.tokens.length - 1]
    const tracked = token && containerTypes.has(token.type)
    let quoteFrame
    if (tracked) {
      if (!state.criticLineStarts) state.criticLineStarts = helpers.lineStarts(state.src)
      if (!state.criticQuoteFrames) state.criticQuoteFrames = []
      if (token.type === 'blockquote_open') {
        quoteFrame = new Map()
        for (let line = startLine; line < endLine; line++) {
          const quote = state.src.slice(state.criticLineStarts[line], state.bMarks[line]).lastIndexOf('>')
          if (quote !== -1) quoteFrame.set(line, quote)
        }
        state.criticQuoteFrames.push(quoteFrame)
      }
      const content = state.bMarks[startLine] + state.tShift[startLine]
      token.criticContainer = {
        prefix: state.src.slice(state.criticLineStarts[startLine], content),
        empty: content >= state.eMarks[startLine],
        quotePositions: state.criticQuoteFrames.map(frame => frame.get(startLine)).filter(pos => pos !== undefined)
      }
    }
    try { return blockTokenize.call(this, state, startLine, endLine, ...args) } finally {
      if (quoteFrame) state.criticQuoteFrames.pop()
    }
  }
  function ancestorPrelude (group) {
    const openingLines = new Map()
    for (const node of group.ancestors) {
      if (!containerTypes.has(node.token.type) || !node.token.map || node.token.map[0] >= group.token.map[0]) continue
      openingLines.set(node.token.map[0], node)
    }
    let prelude = ''
    for (const node of openingLines.values()) {
      const context = node.token.criticContainer
      if (!context) throw new Error('Missing parsed ancestor context: ' + node.token.type)
      let prefix = context.prefix
      if (node.token.type === 'list_item_open' && context.empty) prefix = prefix.trimEnd() + ' '
      const quotes = new Set(context.quotePositions)
      const blank = prefix.split('').map((char, index) => quotes.has(index) ? '>' : /[ \t]/.test(char) ? char : ' ').join('')
      if (node.token.type === 'dd_open') {
        const marker = /[:~][ \t]*$/.exec(prefix)
        if (!marker) throw new Error('Missing native definition prefix')
        prelude += prefix.slice(0, marker.index) + 'context\n'
      }
      prelude += prefix + 'context\n' + blank + '\n'
    }
    return prelude
  }

  function groupTokens (tokens) {
    const roots = []
    const stack = []
    const nodes = []
    for (const token of tokens) {
      for (const node of stack) node.tokens.push(token)
      if (token.nesting >= 0) {
        const node = { token, tokens: [token], ancestors: stack.slice() }
        nodes.push(node)
        if (!stack.length) roots.push(node)
        if (token.nesting > 0) stack.push(node)
      } else stack.pop()
    }
    return { roots, nodes }
  }

  function recoveryState (source, tokens) {
    const state = new md.block.State(source, md, {}, tokens)
    state.criticRecoveryReads = new Map()
    const isEmpty = state.isEmpty
    state.isEmpty = function (line) {
      if (this.criticRecoveryRead) this.criticRecoveryRead.line = Math.max(this.criticRecoveryRead.line, line)
      return isEmpty.call(this, line)
    }
    const getLines = state.getLines
    state.getLines = function (begin, end, indent, keepLastLF) {
      if (this.criticRecoveryRead) this.criticRecoveryRead.line = Math.max(this.criticRecoveryRead.line, end - 1)
      return getLines.call(this, begin, end, indent, keepLastLF)
    }
    const push = state.push
    state.push = function (...args) {
      const token = push.apply(this, args)
      if (this.criticRecoveryRead) token.criticReadTo = this.criticRecoveryRead.line
      return token
    }
    return state
  }

  function recover (raw, markers, selected, outerEnv, certification) {
    const atoms = []
    for (const match of raw.matchAll(markerRE)) {
      const span = markers[match[0]]
      if (!span || !selected.has(match[0]) || span.type !== 'comment') continue
      const content = helpers.normalizeSource(span.raw)
      const from = match.index + match[0].length
      if (raw.slice(from, from + content.length) !== content) return null
      atoms.push({
        from: match.index,
        body: from,
        end: from + content.length,
        marker: match[0],
        rootFence: certification && /\n {0,3}(?:`{3,}|~{3,})/.test(content),
        span
      })
    }
    const reject = new Set()
    const admitted = new Set()
    const unusedFootnoteReject = new Set()
    if (!atoms.length) return { reject, unusedFootnoteReject, complete: true, from: raw.length }
    let cursor = certification ? certification.start : 0
    let atomIndex = 0
    let continuation = ''
    let recoveryWork = 0
    let movedHTML = false
    const tags = []
    const env = Object.assign({}, outerEnv, { criticSuggestions: undefined, native: Object.assign(Object.create(null), markers), nativeTags: tags })
    if (outerEnv.footnotes) env.footnotes = JSON.parse(JSON.stringify(outerEnv.footnotes))
    const partial = () => ({ reject, unusedFootnoteReject, complete: false, from: cursor })
    function movesHTML (node, children) {
      return node && node.ancestors.some(parent => parent.token.type === 'footnote_reference_open') &&
        children.some(child => child.type === 'html_inline')
    }
    function rawOwnership (block, atom) {
      // Footnote HTML is relocated and shadowed definitions can disappear.
      // Their tag scope must be checked in final rendered order.
      if (movedHTML) return undefined
      const tokens = block.prefix.concat(block.tokens)
      const nodes = new Map(block.nodes.map(node => [node.token, node]))
      const literalTags = tags.slice()
      const probeEnv = { references: env.references, criticSuggestions: markers, criticValidation: true }
      if (env.footnotes && env.footnotes.refs) {
        const definitions = env.footnotes.refs
        probeEnv.footnotes = {
          refs: new Proxy(Object.create(null), {
            get (target, label) {
              if (Object.prototype.hasOwnProperty.call(target, label)) return target[label]
              return definitions[label] === undefined ? undefined : -1
            }
          })
        }
      }
      for (const token of tokens) {
        if (token.type !== 'inline') continue
        const children = []
        md.inline.parse(token.content, md, probeEnv, children)
        const node = nodes.get(token)
        if (movesHTML(node, children)) {
          movedHTML = true
          return undefined
        }
        let script = 0
        for (const child of children) {
          updateTags(literalTags, child)
          if (/^(sup|sub)_open$/.test(child.type)) script++
          if (/^(sup|sub)_close$/.test(child.type)) script--
          // Only a directly parsed marker proves ownership; missing tokens may
          // belong to a comment whose body crosses this raw paragraph's end.
          if (child.type === 'critic_validated' && child.content === atom.marker) return literalTags.length ? 'literal' : script ? undefined : 'prose'
        }
      }
      return undefined
    }
    function followingFence (state, node, prefixLength) {
      if (!certification || node.ancestors.length || node.token.type !== 'footnote_reference_open') return null
      const line = state.skipEmptyLines(node.token.map[1])
      if (line >= state.lineMax) return null
      const savedLine = state.line
      const count = state.tokens.length
      const rule = md.block.ruler.__rules__.find(rule => rule.name === 'fence').fn
      const matched = rule(state, line, state.lineMax, false)
      const token = matched && state.tokens[state.tokens.length - 1]
      state.tokens.length = count
      state.line = savedLine
      return token ? { token, from: state.bMarks[line] - prefixLength } : null
    }
    function firstBlock (source, targetOffset = atoms[atomIndex].from - cursor) {
      const input = continuation + source
      recoveryWork += input.length
      const prefixLines = helpers.lineStarts(continuation).length - 1
      const target = continuation.length + targetOffset
      const tokens = []
      const state = recoveryState(input, tokens)
      const containers = new Set(['blockquote_open', 'bullet_list_open', 'ordered_list_open', 'list_item_open', 'dl_open', 'dd_open', 'footnote_reference_open'])
      const prefix = []
      const previousNodes = []
      function select (firstToken) {
        const { nodes } = groupTokens(tokens.slice(firstToken))
        const skipped = new Set()
        for (const node of nodes) {
          const token = node.token
          if (skipped.has(token)) continue
          if (!token.map || token.type === 'inline' || Math.max(token.map[1], token.map[0] + 1) <= prefixLines) continue
          const unusedFootnote = token.type === 'footnote_reference_open' && (!outerEnv.footnotes || outerEnv.footnotes.refs[':' + token.meta.label] < 0)
          if (containers.has(token.type) && !unusedFootnote) continue
          if (token.map[0] < prefixLines && !unusedFootnote) continue
          const endLine = Math.max(token.map[1], token.map[0] + 1)
          const literal = unusedFootnote || /^(fence|code_block|html_block)$/.test(token.type)
          if (state.bMarks[endLine] <= target) {
            for (const token of node.tokens) {
              skipped.add(token)
              if (!literal || (certification && unusedFootnote)) prefix.push(token)
            }
            continue
          }
          const ancestorGroup = { token: { map: [Infinity, Infinity] }, ancestors: node.ancestors }
          let next = ancestorPrelude(ancestorGroup)
          if (token.type === 'dt_open') {
            const definition = nodes.find(n => n.token.type === 'dd_open' && n.token.map[0] >= endLine && n.ancestors.some(parent => node.ancestors.includes(parent)))
            const prefix = definition && definition.token.criticContainer && definition.token.criticContainer.prefix
            const marker = prefix && /[:~][ \t]*$/.exec(prefix)
            if (!marker) return null
            next += prefix.slice(0, marker.index) + 'context\n'
          }
          return {
            tokens: node.tokens,
            state,
            followingFence: followingFence(state, node, continuation.length),
            start: Math.max(0, state.bMarks[token.map[0]] - continuation.length),
            prefix,
            node,
            nodes: previousNodes.concat(nodes),
            from: state.bMarks[token.map[0]] - continuation.length,
            end: state.bMarks[endLine] - continuation.length,
            complete: Math.max(endLine + 2, (token.criticReadTo || 0) + 1) < state.lineMax,
            next,
            literal,
            unusedFootnote
          }
        }
        for (const node of nodes) previousNodes.push(node)
        return undefined
      }
      while (state.line < state.lineMax) {
        const line = state.skipEmptyLines(state.line)
        if (line >= state.lineMax) break
        state.line = line
        let matched = false
        const firstToken = tokens.length
        for (const rule of md.block.ruler.getRules('')) {
          if (rule(state, line, state.lineMax, false)) { matched = true; break }
        }
        if (!matched) throw new Error('No block rule matched recovery source')
        const result = select(firstToken)
        if (result) return result
        if (result === null) return { end: source.length, complete: false, unsupported: true }
      }
      return { tokens: [], prefix, nodes: previousNodes, end: source.length, complete: true, next: '' }
    }
    function project (from, to, opaque) {
      let source = ''
      let pos = from
      const pieces = []
      for (let i = atomIndex; i < atoms.length && atoms[i].from < to; i++) {
        const atom = atoms[i]
        if (atom.from < from || atom.end > to) continue
        if (certification
          ? !certification.reachable.has(certification.owners.get(atom.marker))
          : opaque ? !opaque.has(atom.span) : reject.has(atom.span)) continue
        const part = raw.slice(pos, atom.body)
        pieces.push({ at: source.length, raw: pos })
        source += part
        pieces.push({ at: source.length, raw: atom.end })
        pos = atom.end
      }
      pieces.push({ at: source.length, raw: pos })
      source += raw.slice(pos, to)
      recoveryWork += source.length
      return {
        source,
        original (offset) {
          let i = pieces.length - 1
          while (i > 0 && pieces[i].at > offset) i--
          return pieces[i].raw + offset - pieces[i].at
        },
        projected (offset) {
          let i = pieces.length - 1
          while (i > 0 && pieces[i].raw > offset) i--
          return pieces[i].at + offset - pieces[i].raw
        }
      }
    }
    let ordered = false
    while (cursor < raw.length) {
      while (atomIndex < atoms.length && atoms[atomIndex].from < cursor) atomIndex++
      if (atomIndex >= atoms.length) break
      let targetIndex = atomIndex
      if (certification) {
        // Intervening definitions remain raw in the prefix. Only a body with
        // a possible root fence can certify the next hidden suffix.
        while (targetIndex < atoms.length && (!atoms[targetIndex].rootFence || certification.reachable.has(certification.owners.get(atoms[targetIndex].marker)))) targetIndex++
        if (targetIndex >= atoms.length) break
      }
      let count = 4
      let projected, block, literal, rawBlock, limit, rawAdvance, rawProjection
      let admittedNext = false
      let batchAttempt = false
      let decisionIndex = atomIndex
      while (decisionIndex < atoms.length && (admitted.has(atoms[decisionIndex].span) || reject.has(atoms[decisionIndex].span))) decisionIndex++
      for (;;) {
        const last = Math.min(atoms.length - 1, certification ? targetIndex + count - 1 : Math.max(atomIndex + count - 1, decisionIndex))
        limit = atoms[last].end
        let newline = raw.indexOf('\n', limit)
        limit = newline < 0 ? raw.length : newline + 1
        // Keep a whole physical line and every body beginning on it. A partial
        // body would expose Markdown that disappears in the full projection.
        for (let i = last + 1; i < atoms.length && atoms[i].from < limit; i++) {
          newline = raw.indexOf('\n', atoms[i].end)
          limit = newline < 0 ? raw.length : newline + 1
        }
        if (last === atoms.length - 1) limit = raw.length
        if (certification) {
          projected = project(cursor, limit)
          block = firstBlock(projected.source, projected.projected(atoms[targetIndex].from))
          if (block.unsupported) return partial()
          if (limit === raw.length || block.complete) break
          count *= 2
          continue
        }
        rawProjection = project(cursor, limit, admitted)
        const decision = atoms[decisionIndex] || atoms[atomIndex]
        rawBlock = firstBlock(rawProjection.source, rawProjection.projected(decision.from))
        if (rawBlock.unsupported) return partial()
        // A long prose run stays at one cursor while its bodies become opaque.
        // Bound that repeated work by one remaining-source pass before batching.
        batchAttempt = batchAttempt || (ordered && recoveryWork >= raw.length - cursor)
        if (limit === raw.length || rawBlock.complete) {
          const ownership = rawOwnership(rawBlock, decision)
          if (ownership === 'literal') {
            reject.add(decision.span)
            delete env.native[decision.marker]
            ordered = true
          } else if (ordered && !batchAttempt && decisionIndex < atoms.length && ownership === 'prose' && rawProjection.original(rawBlock.end) < decision.end) {
            admitted.add(decision.span)
            admittedNext = true
            break
          }
          if (rawBlock.literal || reject.has(decision.span)) {
            literal = rawBlock.literal
            rawAdvance = true
            block = rawBlock
            break
          }
        }
        projected = project(cursor, limit)
        block = firstBlock(projected.source)
        if (block.unsupported) return partial()
        literal = rawBlock.literal
        rawAdvance = literal || rawProjection.original(rawBlock.end) <= atoms[atomIndex].from
        // A raw opener has priority: removing a body can hide its closing fence
        // or join an outside backtick onto the fence's info string.
        if (rawAdvance) {
          block = rawBlock
        } else if (block.literal) {
          return partial()
        }
        if (limit === raw.length || (block.complete && rawBlock.complete)) break
        count *= 2
      }
      if (admittedNext) continue
      const end = rawAdvance ? rawProjection.original(block.end) : projected.original(block.end)
      if (end <= cursor) return partial()
      if (certification) {
        // Collect the entire newly exposed prefix before hiding more bodies.
        // An uncertified suffix returns to the caller's whole-document parse.
        const next = block.followingFence
        if (!next || !next.token.criticUnclosedFence) return partial()
        const fenceFrom = projected.original(next.from)
        const target = atoms[targetIndex]
        const proofs = certification.proofs.get(next.token.markup[0]) || []
        if (!proofs.some(proof => proof.span.from < target.span.from && proof.minWidth <= next.token.markup.length)) return partial()
        if (fenceFrom < target.body || fenceFrom >= target.end) return partial()
        for (const range of block.state.env.criticReferenceRanges || []) {
          if (intersectsBody(certification.bodies, projected.original(range[0]), projected.original(range[1]))) return partial()
        }
        for (const node of block.nodes) {
          if (node.token.type !== 'footnote_reference_open' || !node.token.map) continue
          const from = projected.original(block.state.bMarks[node.token.map[0]])
          if (intersectsBody(certification.bodies, from, from + 1)) return partial()
        }
        const before = certification.reachable.size
        const previous = certification.rawEnvironment
        const references = Object.assign({}, block.state.env.references, previous.references)
        const definitions = Object.assign({}, previous.footnotes && previous.footnotes.refs, block.state.env.footnotes && block.state.env.footnotes.refs)
        const refs = Object.create(null)
        for (const key of Object.keys(definitions)) refs[key] = -1
        const inlineEnv = { references, footnotes: { refs } }
        const inline = block.prefix.concat(block.tokens).filter(token => token.type === 'inline')
        for (const token of inline) md.inline.parse(token.content, md, inlineEnv, [])
        for (const note of inlineEnv.footnotes.list || []) {
          if (note.label !== undefined && certification.labels.has(note.label)) certification.reachable.add(note.label)
        }
        for (const label of certification.reachable) {
          for (const target of certification.edges.get(label) || []) certification.reachable.add(target)
          outerEnv.footnotes.refs[':' + label] = 0
        }
        if (certification.reachable.size === before) return partial()
        for (const token of inline) {
          for (const match of token.content.matchAll(/\[\^([^\] \n]+)\]/g)) {
            if (certification.labels.has(match[1]) && !certification.reachable.has(match[1])) return partial()
          }
        }
        certification.rawEnvironment = { references, footnotes: { refs: definitions } }
        cursor = projected.original(block.start)
        continuation = ancestorPrelude(block.node)
        continue
      }
      const accepted = new Set()
      const previousTags = tags.slice()
      env.nativeDeferred = new Set()
      const inlineNodes = new Map(block.nodes.map(node => [node.token, node]))
      function analyze (tokens) {
        for (const token of tokens) {
          if (token.type !== 'inline') continue
          const children = []
          if (parseInline) {
            parseInline(token, inlineNodes.get(token), env, children)
          } else {
            md.inline.parse(expand(token.content, markers), md, env, children)
          }
          const node = inlineNodes.get(token)
          if (movesHTML(node, children)) movedHTML = true
          for (const child of children) {
            updateTags(tags, child)
            if (!tags.length && child.type === 'critic_native') accepted.add(markers[child.content])
          }
        }
      }
      analyze(block.prefix)
      if (literal) {
        const from = rawProjection.original(block.from)
        const rejected = block.unusedFootnote ? unusedFootnoteReject : reject
        for (let i = atomIndex; i < atoms.length && atoms[i].from < end; i++) {
          const atom = atoms[i]
          if (atom.from >= from) rejected.add(atom.span)
          else if (!accepted.has(atom.span) && !reject.has(atom.span) && !unusedFootnoteReject.has(atom.span)) return partial()
        }
      } else {
        analyze(block.tokens)
        let expanded = false
        for (let i = atomIndex; i < atoms.length && atoms[i].from < end; i++) {
          const atom = atoms[i]
          // Reparse with the full admitted body hidden before advancing: the
          // raw block boundary may otherwise land inside that opaque body.
          if (atom.end > end && accepted.has(atom.span) && !admitted.has(atom.span)) {
            admitted.add(atom.span)
            expanded = true
          }
        }
        if (expanded) {
          tags.splice(0, tags.length, ...previousTags)
          continue
        }
        let missing = false
        for (let i = atomIndex; i < atoms.length && atoms[i].from < end; i++) {
          const atom = atoms[i]
          if (accepted.has(atom.span) || reject.has(atom.span)) continue
          missing = true
        }
        if (missing && batchAttempt) {
          const before = admitted.size
          for (const span of accepted) admitted.add(span)
          if (admitted.size > before) {
            tags.splice(0, tags.length, ...previousTags)
            recoveryWork = 0
            continue
          }
        }
        if (missing) return partial()
      }
      cursor = end
      continuation = block.next
      recoveryWork = 0
    }
    return { reject, unusedFootnoteReject, complete: true, from: cursor }
  }

  function certifyReferences (raw, markers, selected, { owners, reachable, edges, labels, rawEnvironment, proofs }) {
    const empty = { complete: false }
    // The preceding raw parse proves that this root fence hides the full tail.
    // Reuse that proof only after its containing comment becomes reachable.
    const node = rawEnvironment.sourceGroups.nodes.find(node => node.token.type === 'fence' && !node.ancestors.length && node.token.criticUnclosedFence)
    if (!node) return empty
    const starts = helpers.lineStarts(raw)
    const from = starts[node.token.map[0]]
    // An opaque comment leaves its marker on the joined line, so collapsing
    // bodies can remove closing-fence lines but cannot create new ones.
    const closers = node.token.markup[0] === '`' ? /^ {0,3}(`{3,})[ \t]*$/gm : /^ {0,3}(~{3,})[ \t]*$/gm
    closers.lastIndex = starts[node.token.map[0] + 1] || raw.length
    let minWidth = 3
    let closing
    while ((closing = closers.exec(raw))) minWidth = Math.max(minWidth, closing[1].length + 1)
    if (minWidth > node.token.markup.length) return empty
    let removed = false
    let start
    const bodies = []
    for (const match of raw.matchAll(markerRE)) {
      const span = markers[match[0]]
      if (!span || span.type !== 'comment' || !selected.has(match[0])) continue
      const begin = match.index + match[0].length
      const end = begin + helpers.normalizeSource(span.raw).length
      bodies.push({ from: begin, to: end })
      if (begin <= from && from < end) {
        const existing = proofs.get(node.token.markup[0]) || []
        if (!existing.some(proof => proof.span === span && proof.minWidth === minWidth)) existing.push({ span, minWidth })
        proofs.set(node.token.markup[0], existing)
        if (reachable.has(owners.get(match[0]))) {
          removed = true
          const definition = rawEnvironment.sourceGroups.roots.find(candidate =>
            candidate.token.type === 'footnote_reference_open' && candidate.token.map &&
            starts[candidate.token.map[0]] <= match.index &&
            (starts[candidate.token.map[1]] || raw.length) > match.index)
          if (definition) start = starts[definition.token.map[0]]
        }
      }
    }
    if (!removed || start === undefined) return empty
    for (const range of rawEnvironment.criticReferenceRanges || []) if (intersectsBody(bodies, range[0], range[1])) return empty
    for (const candidate of rawEnvironment.sourceGroups.nodes) {
      if (candidate.token.type !== 'footnote_reference_open' || !candidate.token.map) continue
      const begin = starts[candidate.token.map[0]]
      if (intersectsBody(bodies, begin, begin + 1)) return empty
    }
    // Later definitions can change how an earlier unresolved reference parses.
    for (const candidate of rawEnvironment.sourceGroups.nodes) {
      if (candidate.token.type !== 'inline') continue
      for (const match of candidate.token.content.matchAll(/\[\^([^\] \n]+)\]/g)) {
        if (labels.has(match[1]) && !reachable.has(match[1])) return empty
      }
    }
    const refs = Object.create(null)
    for (const label of owners.values()) refs[':' + label] = reachable.has(label) ? 0 : -1
    return recover(raw, markers, selected, { footnotes: { refs } }, {
      owners, reachable, edges, labels, rawEnvironment, bodies, proofs, start
    })
  }
  return { recover, ancestorPrelude, groupTokens, certifyReferences }
}
