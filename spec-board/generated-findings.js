const crypto = require('crypto')
const { assertNoCredentials } = require('./sensitive-content')
const { ITEM } = require('./prosediff')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const invalid = message => Object.assign(new Error(message), { status: 422, code: 'review-finding-invalid' })
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const normalize = value => value.replace(/\s+/g, ' ').trim()

function evidenceAnchor (body, quote) {
  const at = body.indexOf(quote)
  if (at < 0 || body.indexOf(quote, at + 1) !== -1) throw invalid('Finding evidence must quote one exact, unambiguous source passage.')
  const passages = []
  let start = 0, offset = 0, itemId = null, fenced = false
  const flush = end => { if (end > start) passages.push({ start, end, id: itemId }) }
  for (const line of body.split('\n')) {
    const fence = /^\s*(```|~~~)/.test(line)
    const item = !fenced && ITEM.exec(line)
    if (!line.trim() || fence || (!fenced && (/^#{1,6}\s/.test(line) || item))) {
      flush(offset)
      start = offset
      itemId = item ? item[1] : null
    }
    offset += line.length + 1
    if (!line.trim()) start = offset
    if (fence) fenced = !fenced
  }
  flush(body.length)
  const segment = passages.find(part => part.start <= at && part.end >= at + quote.length)
  if (!segment) throw invalid('Finding evidence must stay within one requirement or paragraph.')
  const passage = body.slice(segment.start, segment.end).trim()
  const id = segment.id || /^\s*(?:#{1,6}\s+)?(?:[-*]\s+)?(?:\*\*)?((?:[A-Z]{1,6}-\d{1,5}|[A-Z]{1,4}\d{1,5}))(?:\*\*)?(?=\s*[:.)—-]|\s)/.exec(passage)?.[1]
  return `${id || 'text'}:${digest(normalize(passage))}`
}

function normalizeFinding (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Invalid generated finding.')
  const { actor, producer, kind } = input
  if (actor?.kind !== 'automation' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(actor.id || '') || !text(actor.login, 80)) throw invalid('A configured automation identity is required.')
  if (!['spec-review', 'checkpoint', 'consistency'].includes(producer) || !['conflict', 'overlap'].includes(kind) || !text(input.body, 2000)) throw invalid('Invalid finding origin or explanation.')
  if (!Array.isArray(input.evidence) || input.evidence.length !== 2) throw invalid('A shared finding requires two sources.')
  if (typeof input.occurrenceKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.occurrenceKey)) throw invalid('A source-bound occurrence key is required.')
  if (input.settingsFingerprint != null && !/^[a-f0-9]{64}$/.test(input.settingsFingerprint)) throw invalid('Invalid review configuration fingerprint.')
  const evidence = input.evidence.map(source => {
    if (!source || !/^[\w-]{1,128}$/.test(source.noteId || '') || !/^[a-f0-9]{64}$/.test(source.contentHash || '') ||
        !text(source.body, 128000) || Buffer.byteLength(source.body) > 128000 || !text(source.quote, 500)) throw invalid('Invalid finding source.')
    const quote = source.quote.trim()
    if (quote.length < 8) throw invalid('Finding evidence is too short to identify its source.')
    return { noteId: source.noteId, contentHash: source.contentHash, body: source.body,
      anchor: evidenceAnchor(source.body, quote), quote }
  }).sort((a, b) => a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0)
  if (evidence[0].noteId === evidence[1].noteId) throw invalid('A shared finding requires different specs.')
  assertNoCredentials(input.body + '\n' + evidence.map(source => source.body).join('\n'))
  return { actor: { kind: 'automation', id: actor.id, login: actor.login.trim() }, producer, kind,
    body: input.body.trim(), evidence,
    findingKey: digest(JSON.stringify(evidence.map(source => [source.noteId, source.anchor]))),
    occurrenceKey: input.occurrenceKey,
    ...(input.settingsFingerprint ? { settingsFingerprint: input.settingsFingerprint } : {}) }
}

module.exports = { normalizeFinding, evidenceAnchor }
