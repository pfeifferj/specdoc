const assert = require('assert/strict')
const { pendingReviewers, reviewVersion, reminderCurrent, createReviewReminders } = require('./review-reminders')

const review = { id: 'note', namespace: 'team/specs', public: true, policyKnown: true,
  status: 'in-review', required: 1, approvers: ['101', '102'], approved: [],
  contentHash: 'candidate-a', policyHash: 'policy-a', policySnapshot: { namespace: 'team/specs', roles: {} } }
assert.deepEqual(pendingReviewers(review), ['101', '102'])
assert.deepEqual(pendingReviewers({ ...review, approved: ['101'] }), [])
assert.deepEqual(pendingReviewers({ ...review, required: 2, approved: ['101'] }), ['102'])
assert.deepEqual(pendingReviewers({ ...review, status: 'approved' }), ['101', '102'])
for (const extra of [{ public: false }, { policyKnown: false }, { status: 'draft' },
  { retired: true }, { blocked: true }, { required: 0 }, { required: 3 }]) {
  assert.deepEqual(pendingReviewers({ ...review, ...extra }), [])
}
const value = { kind: 'review-attention', reviewer: '101', reviewVersion: reviewVersion(review) }
assert.notEqual(reviewVersion({ ...review, candidateHash: 'before-owner-change' }),
  reviewVersion({ ...review, candidateHash: 'after-owner-change' }), 'semantic metadata changes start a new reminder version')
assert.equal(reminderCurrent(review, value), true)
for (const extra of [{ approved: ['101'] }, { approvers: ['102'] }, { contentHash: 'candidate-b' },
  { policyHash: 'policy-b' }, { public: false }, { blocked: true }]) {
  assert.equal(reminderCurrent({ ...review, ...extra }, value), false)
}

async function main () {
  let current = review, recipients = [{ email: 'alice@example.test' }], queued = [], updates = 0, reads = 0, inside = false, due = true
  const client = { query: async sql => {
    if (sql.startsWith('SELECT 1')) return { rows: due ? [{}] : [] }
    if (sql.startsWith('SELECT reviewer')) return { rows: [{ reviewer: '101', version: reviewVersion(review) }] }
    if (sql.includes('SET queued_at')) updates++
    return { rows: [] }
  } }
  const service = createReviewReminders({ db: client, withTx: async fn => {
    inside = true
    try { return await fn(client) } finally { inside = false }
  },
    loadReview: async (id, db, options = {}) => {
      reads++
      if (options.refreshPolicy) assert.equal(inside, false, 'policy fetches must precede database transactions')
      if (inside) assert.deepEqual(options.policySnapshot, review.policySnapshot, 'transaction rechecks reuse the prepared policy')
      return current
    }, recipients: async () => recipients,
    enqueue: async (...args) => { queued.push(args) } })
  assert.deepEqual(await service.observe('note'), { queued: 1 })
  assert.equal(updates, 1)
  assert.equal(queued[0][1].reviewer, '101')
  assert.deepEqual(queued[0][1].reasons, ['review-requested'])
  due = false
  reads = 0
  assert.deepEqual(await service.observe('note'), { queued: 0 })
  assert.equal(reads, 1, 'reviews that are not due use the cached policy only')
  due = true
  recipients = []
  assert.deepEqual(await service.observe('note'), { queued: 0 })
  assert.equal(updates, 1, 'missing addresses do not consume the reminder')
  current = { ...review, approved: ['102'] }
  const regular = { note_id: 'note', event: { kind: 'discussion' } }
  assert.deepEqual(await service.filter([regular, { note_id: 'note', event: value }]), [regular])
  current = review
  const reminder = { note_id: 'note', event: value }
  reads = 0
  assert.deepEqual(await service.filter([reminder, reminder]), [reminder, reminder])
  assert.equal(reads, 1)
  current = { ...review, blocked: true }
  assert.deepEqual(await service.partition([regular, reminder]), { visible: [regular], deferred: [reminder], unavailable: [] })
  recipients = [{ email: 'alice@example.test' }]
  assert.deepEqual(await service.partition([reminder], 'removed@example.test'), { visible: [], deferred: [], unavailable: [] }, 'blocked reminders still honor changed preferences')
  for (const extra of [{ approved: ['101'] }, { contentHash: 'changed' }, { public: false }, { retired: true }]) {
    current = { ...review, blocked: true, ...extra }
    assert.deepEqual(await service.partition([reminder]), { visible: [], deferred: [], unavailable: [] }, 'stale or ineligible reminders are discarded')
  }
  current = { ...review, policyKnown: false }
  await assert.rejects(service.filter([reminder]), /waiting for policy/)
  assert.deepEqual(await service.partition([regular, reminder]), { visible: [regular], deferred: [reminder], unavailable: [reminder] })
  const disabled = createReviewReminders({ db: client, withTx: fn => fn(client), delayHours: 0,
    loadReview: () => { throw new Error('disabled reminders must not read') } })
  assert.deepEqual(await disabled.observe('note'), { queued: 0 })
  assert.deepEqual(await disabled.filter([regular, reminder]), [regular])
  console.log('review reminders: eligibility, version changes, delivery checks and disabled configuration passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
