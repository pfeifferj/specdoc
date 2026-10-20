const { createHash } = require('crypto')
const MarkdownIt = require('markdown-it')
const reference = require('markdown-it/lib/rules_block/reference')

const md = new MarkdownIt({ html: true })
md.block.ruler.at('reference', (state, start, end, silent) => {
  const before = state.env.referenceLabels.length
  const matched = reference(state, start, end, silent)
  if (matched && !silent) {
    for (let i = before; i < state.env.referenceLabels.length; i++) {
      state.env.sourceReferences.set(state.env.referenceLabels[i], { start: start + 1, end: state.line })
    }
  }
  return matched
})

const bodyHash = body => createHash('sha256').update(body).digest('hex').slice(0, 16)
const sectionId = (noteId, hash, number) => `section:${encodeURIComponent(noteId)}:${hash}:${number}`

function parseSectionId (id) {
  const match = /^section:([^:]+):([a-f0-9]{16}):([1-9]\d*)$/.exec(id)
  if (!match) return null
  try {
    const noteId = decodeURIComponent(match[1])
    const number = Number(match[3])
    if (!noteId || /[\x00-\x1f\x7f]/.test(noteId) || !Number.isSafeInteger(number)) return null
    return { noteId, hash: match[2], number }
  } catch {
    return null
  }
}

function referenceLookup (tokens, env, slice) {
  if (!env.sourceReferences.size) return () => []
  const byDestination = new Map()
  let order = 0
  for (const [label, range] of env.sourceReferences) {
    const href = env.references[label].href
    if (!byDestination.has(href)) byDestination.set(href, [])
    byDestination.get(href).push({ heading: `Reference [${label}]`, text: slice(range.start, range.end), ...range, order: order++ })
  }
  const uses = []
  const collect = (token, refs) => {
    const href = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null
    for (const ref of byDestination.get(href) || []) refs.add(ref)
    for (const child of token.children || []) collect(child, refs)
  }
  for (const token of tokens) {
    if (!token.map) continue
    const refs = new Set()
    collect(token, refs)
    if (refs.size) uses.push({ start: token.map[0] + 1, end: token.map[1], refs })
  }
  uses.sort((a, b) => a.start - b.start || a.end - b.end)
  const cache = new Map()
  const within = range => {
    const key = `${range.start}:${range.end}`
    if (cache.has(key)) return cache.get(key)
    let low = 0
    let high = uses.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (uses[mid].start < range.start) low = mid + 1
      else high = mid
    }
    const refs = new Set()
    for (let i = low; i < uses.length && uses[i].start <= range.end; i++) {
      if (uses[i].end <= range.end) for (const ref of uses[i].refs) refs.add(ref)
    }
    cache.set(key, refs)
    return refs
  }
  return included => {
    const refs = new Set()
    for (const range of included) for (const ref of within(range)) refs.add(ref)
    return [...refs].filter(ref => !included.some(range => ref.start >= range.start && ref.end <= range.end))
      .sort((a, b) => a.order - b.order)
      .map(({ order, ...ref }) => ref)
  }
}

function requirementItems (tokens) {
  const items = []
  for (let i = 0; i < tokens.length; i++) {
    const list = tokens[i]
    if (list.level !== 0 || !['bullet_list_open', 'ordered_list_open'].includes(list.type)) continue
    const current = []
    let complete = true
    while (++i < tokens.length && tokens[i].level > 0) {
      const item = tokens[i]
      if (item.type !== 'list_item_open' || item.level !== 1) continue
      const inline = tokens[i + 1]?.type === 'paragraph_open' && tokens[i + 2]
      const text = inline?.type === 'inline' ? inline.children.map(t => ['softbreak', 'hardbreak'].includes(t.type) ? '\n' : t.content).join('') : ''
      const label = /^(FR-\d+|SC-\d+)(?=\s|:|$)/.exec(text)?.[1]
      if (!label) complete = false
      current.push({ label, start: item.map[0] + 1, end: item.map[1] })
    }
    if (complete) items.push(...current)
  }
  return items
}

function splitRequirements (node, items, slice) {
  if (!items.length) return [node]
  const scope = []
  let start = node.start
  for (const item of items) {
    if (start < item.start) scope.push({ heading: node.heading, start, end: item.start - 1, text: slice(start, item.start - 1) })
    start = item.end + 1
  }
  if (start <= node.end) scope.push({ heading: node.heading, start, end: node.end, text: slice(start, node.end) })
  return items.map(item => ({
    ...item,
    heading: `${node.heading} > ${item.label}`,
    text: slice(item.start, item.end),
    ancestors: [...node.ancestors, ...scope]
  }))
}

function sections (body) {
  const starts = [0]
  for (const match of body.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length)
  const lineCount = starts.length > 1 && starts.at(-1) === body.length ? starts.length - 1 : starts.length
  const slice = (start, end) => body.slice(starts[start - 1], starts[end] ?? body.length)
  const referenceLabels = []
  const env = {
    sourceReferences: new Map(), referenceLabels,
    references: new Proxy({}, {
      set (target, label, value) {
        if (!Object.hasOwn(target, label)) referenceLabels.push(label)
        return Reflect.set(target, label, value)
      }
    })
  }
  const tokens = md.parse(body, env)
  const headings = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'heading_open' && token.level === 0) {
      headings.push({
        title: tokens[i + 1].content.replace(/\s+/g, ' ').trim(),
        level: Number(token.tag.slice(1)),
        start: token.map[0] + 1,
        contentStart: token.map[1] + 1
      })
    }
  }

  const nodes = []
  const stack = []
  const preambleEnd = headings.length ? headings[0].start - 1 : lineCount
  if (preambleEnd && slice(1, preambleEnd).trim()) {
    const preamble = { heading: 'Introduction', start: 1, end: preambleEnd, text: slice(1, preambleEnd), ancestors: [] }
    nodes.push(preamble)
    stack.push({ ...preamble, level: 0 })
  }
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop()
    const end = headings[i + 1]?.start - 1 || lineCount
    const node = {
      heading: [...stack.filter(n => n.level > 0).map(n => n.title), heading.title].join(' > '),
      title: heading.title,
      level: heading.level,
      start: heading.start,
      end,
      text: slice(heading.start, end),
      ancestors: stack.filter(n => n.hasContent !== false).map(({ heading, text, start, end }) => ({ heading, text, start, end })),
      hasContent: heading.contentStart <= end && !!slice(heading.contentStart, end).trim()
    }
    if (node.hasContent) nodes.push(node)
    stack.push(node)
  }

  if (!nodes.length) nodes.push({ heading: headings.map(h => h.title).join(' > ') || 'Introduction', text: body, start: 1, end: lineCount, ancestors: [] })

  const requirements = requirementItems(tokens)
  let next = 0
  const units = nodes.flatMap(node => {
    while (next < requirements.length && requirements[next].start < node.start) next++
    const first = next
    while (next < requirements.length && requirements[next].end <= node.end) next++
    return splitRequirements(node, requirements.slice(first, next), slice)
  })
  const supportingReferences = referenceLookup(tokens, env, slice)
  return units.map((node, index) => {
    const ancestors = [...node.ancestors]
    const included = [...ancestors, node]
    ancestors.push(...supportingReferences(included))
    return { number: index + 1, heading: node.heading, ...(node.label ? { label: node.label } : {}), text: node.text, ancestors, start: node.start, end: node.end }
  })
}

module.exports = { sections, bodyHash, sectionId, parseSectionId }
