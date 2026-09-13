const DiffMatchPatch = require('diff-match-patch')

const dmp = new DiffMatchPatch()
// The diff runs on the request path of a public route; past this the result
// degrades to a coarser diff rather than holding the event loop.
dmp.Diff_Timeout = 0.3
// Tokens are mapped to code points below the surrogate block and above it,
// never inside; the vocabulary is capped by what fits.
const MAX_TOKENS = 0xffff - 0x800

function encode (a, b) {
  const codes = new Map()
  const table = []
  const enc = text => {
    let out = ''
    for (const t of text.match(/\s+|\S+/g) || []) {
      let c = codes.get(t)
      if (c === undefined) {
        if (table.length >= MAX_TOKENS) return null
        c = table.length
        codes.set(t, c)
        table.push(t)
      }
      out += String.fromCharCode(c < 0xd800 ? c : c + 0x800)
    }
    return out
  }
  const ea = enc(a)
  const eb = ea === null ? null : enc(b)
  return eb === null ? null : { ea, eb, table }
}

// Word-level diff by the lines-to-chars trick over whitespace-delimited
// tokens: a character diff of prose reads as noise, a word diff as edits.
// Falls back to characters when the vocabulary outgrows the code space.
// Returns [[op, text], ...] with op -1, 0, 1.
function wordDiff (a, b) {
  const e = encode(a, b)
  if (!e) {
    const d = dmp.diff_main(a, b)
    dmp.diff_cleanupSemantic(d)
    return d
  }
  const d = dmp.diff_main(e.ea, e.eb, false)
  dmp.diff_cleanupSemantic(d)
  return d.map(([op, text]) => [op, Array.from(text, ch => {
    const c = ch.charCodeAt(0)
    return e.table[c >= 0xe000 ? c - 0x800 : c]
  }).join('')])
}

// The requirement items of a spec body by their stable id: "**FR-001**: text"
// with the text running to the next item, heading or blank line. Fenced code
// is skipped; whitespace is collapsed so a reflow is not a change.
const ITEM = /^\s*(?:[-*]\s*)?\*\*((?:FR|SC)-\d+)\*\*:?\s*(.*)$/
function requirementMap (body) {
  const out = new Map()
  let id = null
  let text = []
  let fenced = false
  const flush = () => { if (id) out.set(id, text.join(' ').replace(/\s+/g, ' ').trim()); id = null }
  for (const line of String(body || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      flush()
      continue
    }
    if (fenced) continue
    const m = ITEM.exec(line)
    if (m) {
      flush()
      id = m[1]
      text = [m[2]]
    } else if (id && line.trim() && !/^#/.test(line)) {
      text.push(line)
    } else {
      flush()
    }
  }
  flush()
  return out
}

const byId = (x, y) => x.localeCompare(y, undefined, { numeric: true })
function requirementDelta (before, after) {
  const added = [...after.keys()].filter(k => !before.has(k)).sort(byId)
  const removed = [...before.keys()].filter(k => !after.has(k)).sort(byId)
  const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k)).sort(byId)
  return { added, removed, changed }
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// An unchanged run longer than the window shows its first and last lines
// with a marker between, so the edits keep enough text around them to be
// placed without the whole document in between.
function fold (text, context, marker) {
  const lines = text.split('\n')
  if (lines.length <= 2 * context + 2) return null
  return [lines.slice(0, context).join('\n'), marker(lines.length - 2 * context), lines.slice(-context).join('\n')]
}

// Inline ins/del over the whole text.
function diffHtml (diff, context = 3) {
  const out = []
  for (const [op, text] of diff) {
    if (op === 1) out.push(`<ins>${esc(text)}</ins>`)
    else if (op === -1) out.push(`<del>${esc(text)}</del>`)
    else {
      const f = fold(text, context, n => `\n<span class="fold">${n} unchanged lines</span>\n`)
      out.push(f ? esc(f[0]) + f[1] + esc(f[2]) : esc(text))
    }
  }
  return out.join('')
}

// The same diff as plain text for a model or a log: [-removed-] and
// {+added+} inline, cut between edits at max characters so no marker is
// left open.
function diffText (diff, max = 4000, context = 2) {
  let out = ''
  for (const [op, text] of diff) {
    let piece
    if (op === 1) piece = `{+${text}+}`
    else if (op === -1) piece = `[-${text}-]`
    else {
      const f = fold(text, context, n => `\n[... ${n} unchanged lines ...]\n`)
      piece = f ? f.join('') : text
    }
    if (out.length + piece.length > max) return out + '\n[... cut ...]'
    out += piece
  }
  return out
}

module.exports = { esc, wordDiff, requirementMap, requirementDelta, diffHtml, diffText }
