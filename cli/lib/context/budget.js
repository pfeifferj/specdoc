// Every response is cut to a token budget; the trailer tells the agent what
// was dropped and how to narrow, which is what keeps it from looping on a
// wider query. Four chars per token is close enough for prose and code.
const tokens = s => Math.ceil(s.length / 4)

// items: strings, each a whole unit (a symbol, a spec); whole items are kept
// or dropped, never split, so a cut result is still parseable.
function clip (items, max, hint) {
  const out = []
  let used = 0
  for (const it of items) {
    const t = tokens(it) + 1
    if (used + t > max) break
    used += t
    out.push(it)
  }
  const cut = items.length - out.length
  if (cut) out.push(`... ${cut} more cut by max_tokens=${max}${hint ? `; ${hint}` : ''}`)
  return out.join('\n')
}

module.exports = { clip }
