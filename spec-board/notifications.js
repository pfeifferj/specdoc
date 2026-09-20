const crypto = require('crypto')
const { scanCritic, parseComment, RESOLVED_MARK, commentAnchorHash } = require('./critic-markup')

const PREVIEW_LIMIT = 20
const DIGEST_LIMIT = 48000
const statusLabels = {
  draft: 'Draft', 'ready-for-review': 'Ready for review', 'in-review': 'In review',
  approved: 'Approved', implemented: 'Implemented', superseded: 'Superseded'
}
const clean = (value, max = 280) => {
  const text = String(value || '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
const link = value => /^https?:\/\/[^\s]+$/i.test(String(value || '')) ? String(value) : ''
const event = (kind, line, fields = {}) => ({ ...fields, version: 1, kind, line: clean(line, 1200) })

// Content fingerprints include resolved messages; moving or resolving a thread
// must not make its existing messages look new. Occurrence counts retain duplicates.
function discussionState (content, url, identify = () => '') {
  const messages = []
  const seen = new Map()
  for (const span of scanCritic(content || '')) {
    if (span.type !== 'comment' || !span.messages.length) continue
    let anchor = ''
    if (!span.resolved) {
      const first = span.messages[0]
      const hash = commentAnchorHash(first.author, first.text)
      const nth = (seen.get(hash) || 0) + 1
      seen.set(hash, nth)
      anchor = `#comment-${hash}${nth > 1 ? '-' + nth : ''}`
    }
    let index = 0
    for (const match of span.raw.matchAll(/\{>>((?:(?!\{>>)[\s\S])*?)<<\}/g)) {
      const message = parseComment(match[1])
      if (!message.author && message.text === RESOLVED_MARK) continue
      const start = span.from + match.index + 3
      const actor = identify(message, { start, end: start + match[1].length })
      messages.push({
        hash: crypto.createHash('sha256').update(JSON.stringify([message.author, message.text])).digest('hex'),
        excerpt: clean(message.text), actor: clean(actor, 80),
        signature: clean(message.author, 80), reply: index++ > 0,
        url: link(url) ? url + anchor : ''
      })
    }
  }
  return { baseline: { version: 1, hashes: messages.map(m => m.hash) }, messages }
}

function discussionEvents (previous, current, spec) {
  if (!previous || previous.version !== 1 || !Array.isArray(previous.hashes)) return []
  const remaining = new Map()
  for (const hash of previous.hashes) remaining.set(hash, (remaining.get(hash) || 0) + 1)
  const changed = current.messages.filter(message => {
    const count = remaining.get(message.hash) || 0
    if (count) { remaining.set(message.hash, count - 1); return false }
    return true
  })
  const line = `Discussion updated on "${spec.title}": ${spec.url}`
  const events = changed.slice(0, PREVIEW_LIMIT).map(message => event('discussion', line, {
    ...message, hash: undefined, noteUrl: spec.url, namespace: spec.namespace
  }))
  if (changed.length > PREVIEW_LIMIT) events.push(event('discussion-summary', line, {
    count: changed.length - PREVIEW_LIMIT, url: spec.url, namespace: spec.namespace
  }))
  return events
}

function recipientDetails (participants, watchers, disabled, emailOf, suppressed = new Set(), only = null) {
  const result = new Map()
  for (const [users, reason] of [[participants, 'participating'], [watchers, 'watching']]) {
    for (const user of users) {
      if (disabled.has(String(user.id)) || (only != null && String(user.id) !== String(only))) continue
      const email = emailOf(user)
      if (!email || suppressed.has(email)) continue
      if (!result.has(email)) result.set(email, new Set())
      result.get(email).add(only != null ? 'approval-stale' : reason)
    }
  }
  return [...result].map(([email, reasons]) => ({ email, reasons: [...reasons] }))
}

function validEvent (value) {
  return value && value.version === 1 && typeof value.kind === 'string' && typeof value.line === 'string'
}

function describe (value) {
  if (value.kind === 'status') {
    const label = statusLabels[value.to] || clean(value.to, 80)
    if (value.to === 'in-review') return 'Review started'
    if (value.to === 'ready-for-review') return 'Ready for review'
    return `Status: ${statusLabels[value.from] || clean(value.from, 80)} → ${label}`
  }
  if (value.kind === 'discussion') return `Discussion updated${value.reply ? ' · reply' : ''}`
  if (value.kind === 'discussion-summary') return `${value.count} more discussion updates; open the spec to read them`
  if (value.kind === 'approval-stale') return 'Your approved text has changed · review the changes'
  if (value.kind === 'approval') return `Approval recorded · ${value.approvals}/${value.required} required approvals`
  return clean(value.line, 1200)
}

function renderDigest (rows, footer = '') {
  const groups = new Map()
  const reviews = new Set(), discussions = new Set(), attention = new Set()
  for (const row of rows) {
    if (!groups.has(row.note_id)) groups.set(row.note_id, { title: clean(row.title || row.note_id, 180), rows: [], priority: false })
    const group = groups.get(row.note_id)
    group.rows.push(row)
    const value = validEvent(row.event) ? row.event : null
    if (value?.kind === 'status' && value.to === 'in-review') reviews.add(row.note_id)
    if (value?.kind.startsWith('discussion')) discussions.add(row.note_id)
    if (value?.kind === 'approval-stale') { group.priority = true; attention.add(row.note_id) }
  }
  const summary = []
  if (attention.size) summary.push(`${attention.size} approved ${attention.size === 1 ? 'spec changed' : 'specs changed'}`)
  if (reviews.size) summary.push(`${reviews.size} ${reviews.size === 1 ? 'review' : 'reviews'} started`)
  if (discussions.size) summary.push(`${discussions.size} ${discussions.size === 1 ? 'discussion' : 'discussions'} updated`)
  const subject = clean('SpecDoc: ' + (summary.length ? summary.join(', ') : groups.size === 1
    ? [...groups.values()][0].title : `activity on ${groups.size} specs`), 220)
  let text = '', omitted = 0
  for (const group of [...groups.values()].sort((a, b) => Number(b.priority) - Number(a.priority))) {
    const reasons = new Set(), urls = new Set(), namespaces = new Set()
    const entries = []
    for (const row of [...group.rows].sort((a, b) => Number(b.event?.kind === 'approval-stale') - Number(a.event?.kind === 'approval-stale'))) {
      const value = validEvent(row.event) ? row.event : null
      if (value) {
        for (const reason of Array.isArray(value.reasons) ? value.reasons : []) reasons.add(reason)
        if (link(value.noteUrl || value.url)) urls.add(link(value.noteUrl || value.url).split('#')[0])
        if (value.namespace) namespaces.add(clean(value.namespace, 120))
      }
      let entry = `- ${value ? describe(value) : clean(row.line, 1200)}`
      if (value?.actor) entry += ` · ${clean(value.actor, 80)}`
      else if (value?.signature) entry += ` · Signed @${clean(value.signature, 80)}`
      const time = row.created_at && new Date(row.created_at)
      if (time && !isNaN(time.getTime())) entry += `\n  Recorded ${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      if (value?.excerpt) entry += `\n  "${clean(value.excerpt)}"`
      if (value && link(value.url)) entry += `\n  ${value.kind === 'approval-stale' ? 'View changes' : value.kind === 'discussion' ? 'Read discussion' : value.kind === 'status' && value.to === 'in-review' ? 'Open review' : 'Open'}: ${link(value.url)}`
      entries.push(entry)
    }
    let heading = `${group.priority ? 'Needs your attention · ' : ''}${group.title}\n`
    if (namespaces.size) heading += `Project: ${[...namespaces].join(', ')}\n`
    const why = []
    if (reasons.has('approval-stale')) why.push('the spec changed since your approval')
    if (reasons.has('participating')) why.push('you own or have edited this spec')
    if (reasons.has('watching')) why.push('you watch this project')
    if (why.length) heading += `Why you received this: ${why.join('; ')}.\n`
    const base = [...urls][0]
    if (base) heading += `Open spec: ${base}\n`
    let included = 0
    for (const entry of entries) {
      const addition = (included ? '' : '\n' + heading) + entry + '\n'
      if (text.length + addition.length > DIGEST_LIMIT) { omitted++; continue }
      text += addition
      included++
    }
  }
  if (omitted) text += `\n${omitted} additional activity ${omitted === 1 ? 'entry was' : 'entries were'} omitted from this digest. Open the board for the current specs.\n`
  return { subject, text: text.trimStart() + '\n' + footer }
}

module.exports = { event, discussionState, discussionEvents, recipientDetails, renderDigest }
