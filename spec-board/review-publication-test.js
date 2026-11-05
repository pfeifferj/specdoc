const assert = require('assert/strict')
const crypto = require('crypto')
const { createReviewedPublication } = require('./review-publication')
const digest = text => crypto.createHash('sha256').update(text).digest('hex')

async function main () {
  const original = { id: 'note', namespace: 'team/specs', ownerId: 'owner', title: 'Rollback', content: 'Retain the checkpoint.' }
  let source = { ...original, public: true, status: 'approved', contentHash: digest(original.content) }
  let approvals = 1, blocked = false, published = [], preparation = 0
  const publisher = createReviewedPublication({
    store: { withPublicationGate: async (id, task) => {
      if (blocked) throw Object.assign(new Error('Resolve the discussion.'), { status: 409 })
      return task('locked-fixture')
    } },
    loadSource: async (id, db, options) => {
      assert.equal(db, 'locked-fixture')
      assert.equal(options.lock, true)
      return source
    },
    prepare: async current => {
      preparation++
      return { spec: { ...current, category: 'fresh-area', approvals }, identities: { author: 'fresh-owner' } }
    },
    canPublish: spec => spec.approvals >= 1,
    publish: async (...args) => { published.push(args); return { number: 1 } }
  })
  await publisher(original, 'stale-area', { author: 'stale-owner' }, { n: 1 }, { state: 'fixture' })
  assert.equal(published[0][1], 'fresh-area')
  assert.deepEqual(published[0][2], { author: 'fresh-owner' })
  assert.deepEqual(published[0][3], { n: 1 })
  approvals = 0
  await assert.rejects(publisher(original), { status: 409 })
  assert.equal(published.length, 1, 'a retraction before the locked check prevents publication')
  approvals = 1
  for (const change of [{ ownerId: 'new-owner' }, { title: 'Different title' }, { namespace: 'another/specs' },
    { contentHash: digest('Changed content') }, { public: false }, { status: 'in-review' }]) {
    source = { ...original, public: true, status: 'approved', contentHash: digest(original.content), ...change }
    await assert.rejects(publisher(original), { status: 409 })
  }
  assert.equal(published.length, 1)
  blocked = true
  const before = preparation
  await assert.rejects(publisher(original), { status: 409 })
  assert.equal(preparation, before, 'the discussion gate precedes identity preparation and external writes')
  console.log('review publication: locked source, fresh quorum and attribution checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
