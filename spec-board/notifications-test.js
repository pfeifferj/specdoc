const assert = require('assert/strict')
const { scanCritic, commentAnchorHash } = require('./critic-markup')
const { discussionState, discussionEvents, recipientDetails, event, renderDigest } = require('./notifications')

const spec = { id: 'a', title: 'SPEC-002 — Schema validation', namespace: 'team/specs', url: 'https://notes.test/a' }
const root = '{>>@Alice: Should this reject unknown fields?<<}'
const reply = '{>>@Bob: Yes; the validation section now explains why.<<}'
const resolved = '{>>%%resolved%%<<}'
const state = content => discussionState(content, spec.url)
const changes = (before, after) => discussionEvents(state(before).baseline, state(after), spec)

assert.deepEqual(discussionEvents(null, state(root), spec), [])
assert.equal(changes('', root).length, 1)
assert.equal(changes(root, root + reply).length, 1)
assert.equal(changes(root, root + reply)[0].reply, true)
assert.equal(changes(root, root + reply)[0].signature, 'Bob')
assert.equal(changes(root, root + reply)[0].actor, '')
assert.equal(changes(root, root + reply)[0].excerpt, 'Yes; the validation section now explains why.')
assert.equal(changes(root, root + reply)[0].url, spec.url + '#comment-' + commentAnchorHash('Alice', 'Should this reject unknown fields?'))
assert.deepEqual(changes(root, root + resolved), [])
assert.deepEqual(changes(root + resolved, root), [])
assert.deepEqual(changes(root + '\n\n' + reply, reply + '\n\n' + root), [])
assert.equal(changes(root + resolved, root + resolved + reply).length, 1)
assert.equal(changes(root, root + '\n\n' + root).length, 1)
assert.equal(changes(root, root + '\n\n' + root)[0].url, state(root).messages[0].url + '-2')
assert.deepEqual(changes(root + '\n\n' + root, root + resolved + '\n\n' + root), [])
assert.equal(state(root + resolved + '\n\n' + root).messages[1].url, state(root).messages[0].url)
assert.equal(state(root + resolved).messages[0].url, spec.url)
assert.equal(changes(root, root.replace('reject', 'accept'))[0].kind, 'discussion')
assert.deepEqual(state('```\n' + root + '\n```\n`' + reply + '`').messages, [])
assert.deepEqual(changes(root, ''), [])
const capped = state(Array.from({ length: 25 }, (_, i) => `{>>@Alice: ${i} ${'word '.repeat(100)}<<}`).join('\n\n'))
const cappedEvents = discussionEvents(state('').baseline, capped, spec)
assert.equal(cappedEvents.length, 21)
assert.equal(cappedEvents[20].count, 5)
assert.equal(capped.baseline.hashes.length, 25)
assert.ok(cappedEvents.slice(0, 20).every(e => e.excerpt.length <= 280))
assert.deepEqual(discussionEvents(capped.baseline, capped, spec), [])

const repeated = root + root
const offsets = []
const cached = JSON.stringify(scanCritic(repeated))
const identified = discussionState(repeated, spec.url, (message, span) => {
  offsets.push(span)
  assert.equal(repeated.slice(span.start, span.end), '@Alice: Should this reject unknown fields?')
  return span.start < root.length ? 'Alice' : ''
})
assert.notEqual(offsets[0].start, offsets[1].start)
assert.equal(identified.messages[0].actor, 'Alice')
assert.equal(identified.messages[1].actor, '')
assert.equal(JSON.stringify(scanCritic(repeated)), cached)

const emailOf = user => user.email.toLowerCase()
const participants = [{ id: 'a', email: 'SHARED@test' }, { id: 'muted', email: 'muted@test' }]
const watchers = [{ id: 'b', email: 'shared@test' }, { id: 'muted', email: 'muted@test' }]
assert.deepEqual(recipientDetails(participants, watchers, new Set(['muted']), emailOf), [
  { email: 'shared@test', reasons: ['participating', 'watching'] }
])
assert.deepEqual(recipientDetails(participants, watchers, new Set(['a', 'muted']), emailOf), [
  { email: 'shared@test', reasons: ['watching'] }
])
assert.deepEqual(recipientDetails(participants, watchers, new Set(), emailOf, new Set(['shared@test']), 'a'), [])
assert.deepEqual(recipientDetails(participants, watchers, new Set(), emailOf, new Set(), 'a'), [
  { email: 'shared@test', reasons: ['approval-stale'] }
])

const row = (id, value) => ({ note_id: id, title: id === 'a' ? spec.title : 'SPEC-001 — State model',
  line: value.line, event: { ...value, reasons: ['watching'], namespace: spec.namespace }, created_at: '2026-09-20T08:15:12Z' })
const started = event('status', 'legacy review line', { from: 'ready-for-review', to: 'in-review', url: spec.url })
const footer = '--\nUnsubscribe: https://board.test/unsub?t=test\nPrivacy: https://board.test/privacy\n'
const rows = [row('a', started), row('b', started), row('a', changes(root, root + reply)[0])]
const digest = renderDigest(rows, footer)
assert.equal(digest.subject, 'SpecDoc: 2 reviews started, 1 discussion updated')
assert.equal(digest.text.split(spec.title).length - 1, 1)
assert.ok(digest.text.includes('@Bob (name typed in the comment, unverified)'))
assert.ok(digest.text.includes('Recorded 2026-09-20 08:15 UTC'))
assert.ok(digest.text.includes('you watch this project'))
assert.ok(digest.text.includes('- Review started\n'))
assert.ok(!digest.text.includes(`Open review: ${spec.url}\n`))
assert.ok(digest.text.includes('Read discussion: ' + spec.url + '#comment-'))
const elsewhere = renderDigest([row('a', event('status', 'x', { from: 'ready-for-review', to: 'in-review',
  url: spec.url + '?review=1', noteUrl: spec.url }))])
assert.ok(elsewhere.text.includes(`Open spec: ${spec.url}\n`))
assert.ok(elsewhere.text.includes(`Open review: ${spec.url}?review=1\n`))
const ready = renderDigest([row('a', event('status', 'x', { from: 'draft', to: 'ready-for-review', url: spec.url }))])
assert.ok(ready.text.includes('- Ready for review\n'))
assert.ok(ready.text.includes(`Open spec: ${spec.url}\n`))
assert.equal(ready.text.split(spec.url).length - 1, 1)
const readyElsewhere = renderDigest([row('a', event('status', 'x', { from: 'draft', to: 'ready-for-review',
  url: spec.url + '?review=1', noteUrl: spec.url }))])
assert.ok(readyElsewhere.text.includes(`Open review: ${spec.url}?review=1\n`))
assert.ok(!readyElsewhere.text.includes('Open for review'))
const settled = renderDigest([row('a', event('status', 'x', { from: 'in-review', to: 'approved', url: spec.url }))])
assert.ok(settled.text.includes(`Open spec: ${spec.url}\n`))
assert.equal(settled.text.split(spec.url).length - 1, 1)
assert.ok(!digest.text.includes('ready-for-review'))
assert.ok(digest.text.endsWith(footer))
const priority = renderDigest([...rows, row('b', event('approval-stale', 'old approval',
  { url: 'https://board.test/changes/b', noteUrl: spec.url }))])
assert.ok(priority.text.indexOf('SPEC-001') < priority.text.indexOf('SPEC-002'))
assert.ok(priority.text.includes('View changes: https://board.test/changes/b'))
assert.ok(priority.subject.includes('1 approved spec changed'))
for (const invalid of [null, { version: 2, kind: 'status' }, { version: 1 }, { version: 1, kind: 2, line: 'x' }]) {
  const legacy = renderDigest([{ note_id: 'legacy', title: 'Legacy title', line: 'A stored event', event: invalid }])
  assert.ok(legacy.text.includes('A stored event'))
  assert.ok(!legacy.text.includes('undefined'))
}
const hostile = renderDigest([{ note_id: 'x', title: 'Title\r\nBcc: victim@test', line: '\u202esecret\0' }])
assert.ok(!/[\r\n]/.test(hostile.subject))
assert.ok(!hostile.text.includes('\u202e'))
const large = renderDigest(Array.from({ length: 2000 }, (_, i) => ({
  ...row(String(i), event('discussion', 'changed', { excerpt: 'x'.repeat(1000), url: spec.url })),
  title: `SPEC-${String(i).padStart(4, '0')} \u2014 Overflow case`
})), footer)
assert.ok(large.text.length < 48000 + footer.length)
const largeOmitted = Number(large.text.match(/\n(\d+) activity entries did not fit in this digest\. /)[1])
const largeNamed = large.text.match(/Entries are missing for (.+?), and (\d+) more specs\.\n/)
assert.equal(largeNamed[1].split('; ').length, 10)
assert.ok(largeNamed[1].split('; ').every(title => /^SPEC-\d{4} \u2014 Overflow case$/.test(title)))
assert.equal(largeOmitted, 10 + Number(largeNamed[2]))
assert.ok(large.text.endsWith(footer))
const fewer = renderDigest(Array.from({ length: 40 }, (_, i) => ({ note_id: 's' + i, title: `SPEC-${i} \u2014 Long line`, line: 'y'.repeat(2000) })), footer)
const fewerOmitted = Number(fewer.text.match(/\n(\d+) activity entries did not fit in this digest\. /)[1])
assert.ok(fewerOmitted >= 1 && fewerOmitted <= 10)
assert.equal(fewer.text.match(/Entries are missing for (.+)\.\n/)[1].split('; ').length, fewerOmitted)
assert.ok(fewer.text.length < 48000 + footer.length)
const trimmedLine = 'Locked "SPEC-001" after approval (owner can still edit): ' + spec.url
const trimmed = renderDigest([row('a', event('activity', trimmedLine, { url: spec.url }))])
assert.equal(trimmed.text.split(spec.url).length - 1, 1)
assert.ok(trimmed.text.includes('- Locked "SPEC-001" after approval (owner can still edit)\n'))
const generic = renderDigest([row('a', event('activity', 'Assigned to milestone Beta', { url: spec.url }))])
assert.equal(generic.text.split(spec.url).length - 1, 1)
assert.ok(!generic.text.includes('Open: '))
const legacyBase = 'https://notes.test/c'
const legacyTitle = 'SPEC-003 \u2014 Legacy queued line'
const legacyAnchor = { note_id: 'c', title: legacyTitle, line: 'x', created_at: '2026-09-20T08:01:00Z',
  event: event('status', 'x', { from: 'draft', to: 'ready-for-review', url: legacyBase, reasons: ['watching'], namespace: spec.namespace }) }
const legacyText = 'Spec "Legacy queued line" moved draft -> ready-for-review: '
const queued = (line, stored) => renderDigest([legacyAnchor, { note_id: 'c', title: legacyTitle, line,
  created_at: '2026-09-20T08:02:00Z',
  event: stored ? event('activity', line, { url: legacyBase, reasons: ['watching'], namespace: spec.namespace }) : null }])
const headingOf = digest => digest.text.slice(0, digest.text.indexOf('\n- '))
for (const stored of [false, true]) {
  const same = queued(legacyText + legacyBase, stored)
  assert.deepEqual(same.text.split('\n').filter(l => l.includes(legacyBase)), [`Open spec: ${legacyBase}`])
  assert.ok(same.text.includes('- Spec "Legacy queued line" moved draft -> ready-for-review\n'))
  const other = queued(legacyText + 'https://notes.test/other', stored)
  assert.ok(other.text.includes(`Open spec: ${legacyBase}\n`))
  assert.ok(other.text.includes('- ' + legacyText + 'https://notes.test/other\n'))
  assert.equal(headingOf(same), headingOf(other))
}

console.log('notification tests passed')
