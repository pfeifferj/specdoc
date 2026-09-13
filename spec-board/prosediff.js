const DiffMatchPatch = require('diff-match-patch')

const dmp = new DiffMatchPatch()
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

// Word-level diff: each whitespace or word run becomes one character, the
// character diff runs on that, semantic cleanup merges the chaff, and the
// tokens are put back. A character diff of prose reads as noise; this reads
// as edits. Falls back to characters when the vocabulary outgrows the code
// space. Returns [[op, text], ...] with op -1, 0, 1.
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
// with the text running to the next item or blank line. Whitespace is
// collapsed so a reflow is not a change.
const ITEM = /^\s*(?:[-*]\s*)?\*\*((?:FR|SC)-\d+)\*\*:?\s*(.*)$/
function requirementMap (body) {
  const out = new Map()
  let id = null
  let text = []
  const flush = () => { if (id) out.set(id, text.join(' ').replace(/\s+/g, ' ').trim()) }
  for (const line of String(body || '').split('\n')) {
    const m = ITEM.exec(line)
    if (m) {
      flush()
      id = m[1]
      text = [m[2]]
    } else if (id && line.trim()) {
      text.push(line)
    } else if (id) {
      flush()
      id = null
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

// Inline ins/del over the whole text, long unchanged runs folded to their
// first and last lines, so the page shows the edits and enough of the text
// to place them.
function diffHtml (diff, context = 3) {
  const out = []
  for (const [op, text] of diff) {
    if (op === 1) out.push(`<ins>${esc(text)}</ins>`)
    else if (op === -1) out.push(`<del>${esc(text)}</del>`)
    else {
      const lines = text.split('\n')
      if (lines.length > 2 * context + 2) {
        out.push(esc(lines.slice(0, context).join('\n')))
        out.push(`\n<span class="fold">${lines.length - 2 * context} unchanged lines</span>\n`)
        out.push(esc(lines.slice(-context).join('\n')))
      } else {
        out.push(esc(text))
      }
    }
  }
  return out.join('')
}

module.exports = { wordDiff, requirementMap, requirementDelta, diffHtml }
