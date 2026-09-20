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
assert.ok(digest.text.includes('Signed @Bob'))
assert.ok(digest.text.includes('Recorded 2026-09-20 08:15 UTC'))
assert.ok(digest.text.includes('you watch this project'))
assert.ok(digest.text.includes('Open review:'))
assert.ok(digest.text.includes('Read discussion:'))
assert.ok(!digest.text.includes('ready-for-review'))
assert.ok(digest.text.endsWith(footer))
const priority = renderDigest([...rows, row('b', event('approval-stale', 'old approval', { url: 'https://board.test/changes/b' }))])
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
const large = renderDigest(Array.from({ length: 2000 }, (_, i) => row(String(i), event('discussion', 'changed', { excerpt: 'x'.repeat(1000), url: spec.url }))), footer)
assert.ok(large.text.length < 48500 + footer.length)
assert.ok(large.text.includes('omitted from this digest'))
assert.ok(large.text.endsWith(footer))
console.log('notification tests passed')
