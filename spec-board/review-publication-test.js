const assert = require('assert/strict')
const { createReviewedPublication } = require('./review-publication')

async function main () {
  let held = false, failAuthorization = false, published = 0, authorized = 0
  const intent = { id: 'submission', document: 'Reviewed text.' }
  const publisher = createReviewedPublication({
    store: { withPublicationLock: async (id, task) => {
      assert.equal(id, 'note')
      held = true
      try { return await task() } finally { held = false }
    } },
    authorize: async (spec, previous, revision) => {
      assert.equal(held, true)
      authorized++
      if (failAuthorization) throw Object.assign(new Error('Review changed'), { status: 409 })
      return { intent, generation: 3 }
    },
    publish: async (spec, previous, revision, context, authorization) => {
      assert.equal(held, true, 'discussions remain excluded after the durable authorization commits')
      assert.equal(authorization.intent, intent)
      assert.equal(authorization.generation, 3)
      published++
      return { number: 7 }
    }
  })
  assert.deepEqual(await publisher({ id: 'note' }, {}, null, {}), {
    opened: { number: 7 }, authorization: { intent, generation: 3 }
  })
  assert.equal(held, false)
  failAuthorization = true
  await assert.rejects(publisher({ id: 'note' }, {}), { status: 409 })
  assert.equal(published, 1, 'an authorization failure never reaches GitHub')
  assert.equal(authorized, 2)
  assert.equal(held, false, 'failure releases the discussion lock')
  console.log('review publication locking and durable authorization passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
