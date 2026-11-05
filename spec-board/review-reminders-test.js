const assert = require('assert/strict')
const { pendingReviewers, reviewVersion, reminderCurrent, createReviewReminders } = require('./review-reminders')

const review = { id: 'note', namespace: 'team/specs', public: true, policyKnown: true,
  status: 'in-review', required: 1, approvers: ['Alice', 'Bob'], approved: [],
  contentHash: 'candidate-a', policyHash: 'policy-a' }
assert.deepEqual(pendingReviewers(review), ['alice', 'bob'])
assert.deepEqual(pendingReviewers({ ...review, approved: ['ALICE'] }), [])
assert.deepEqual(pendingReviewers({ ...review, required: 2, approved: ['alice'] }), ['bob'])
assert.deepEqual(pendingReviewers({ ...review, status: 'approved' }), ['alice', 'bob'])
for (const extra of [{ public: false }, { policyKnown: false }, { status: 'draft' },
  { retired: true }, { blocked: true }, { required: 0 }, { required: 3 }]) {
  assert.deepEqual(pendingReviewers({ ...review, ...extra }), [])
}
const value = { kind: 'review-attention', reviewer: 'alice', reviewVersion: reviewVersion(review) }
assert.equal(reminderCurrent(review, value), true)
for (const extra of [{ approved: ['alice'] }, { approvers: ['bob'] }, { contentHash: 'candidate-b' },
  { policyHash: 'policy-b' }, { public: false }, { blocked: true }]) {
  assert.equal(reminderCurrent({ ...review, ...extra }, value), false)
}

async function main () {
  let current = review, recipients = [{ email: 'alice@example.test' }], queued = [], updates = 0, reads = 0
  const client = { query: async sql => {
    if (sql.startsWith('SELECT reviewer')) return { rows: [{ reviewer: 'alice', version: reviewVersion(review) }] }
    if (sql.includes('SET queued_at')) updates++
    return { rows: [] }
  } }
  const service = createReviewReminders({ db: client, withTx: fn => fn(client),
    loadReview: async () => { reads++; return current }, recipients: async () => recipients,
    enqueue: async (...args) => { queued.push(args) } })
  assert.deepEqual(await service.observe('note'), { queued: 1 })
  assert.equal(updates, 1)
  assert.equal(queued[0][1].reviewer, 'alice')
  assert.deepEqual(queued[0][1].reasons, ['review-requested'])
  recipients = []
  assert.deepEqual(await service.observe('note'), { queued: 0 })
  assert.equal(updates, 1, 'missing addresses do not consume the reminder')
  current = { ...review, approved: ['bob'] }
  const regular = { note_id: 'note', event: { kind: 'discussion' } }
  assert.deepEqual(await service.filter([regular, { note_id: 'note', event: value }]), [regular])
  current = review
  const reminder = { note_id: 'note', event: value }
  reads = 0
  assert.deepEqual(await service.filter([reminder, reminder]), [reminder, reminder])
  assert.equal(reads, 1)
  current = { ...review, policyKnown: false }
  await assert.rejects(service.filter([reminder]), /policy is unavailable/)
  assert.deepEqual(await service.partition([regular, reminder]), { visible: [regular], deferred: [reminder] })
  const disabled = createReviewReminders({ db: client, withTx: fn => fn(client), delayHours: 0,
    loadReview: () => { throw new Error('disabled reminders must not read') } })
  assert.deepEqual(await disabled.observe('note'), { queued: 0 })
  assert.deepEqual(await disabled.filter([regular, reminder]), [regular])
  console.log('review reminders: eligibility, version changes, delivery checks and disabled configuration passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
