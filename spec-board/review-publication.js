const crypto = require('crypto')
const digest = text => crypto.createHash('sha256').update(text).digest('hex')
const changed = () => Object.assign(new Error('The spec or its approval state changed before publication. Review its current state and try again.'), { status: 409 })

function createReviewedPublication ({ store, loadSource, prepare, canPublish, publish }) {
  return (spec, category, identities, revision, context) => store.withPublicationGate(spec.id, async db => {
    const current = await loadSource(spec.id, db, { lock: true })
    if (!current || !current.public || current.namespace !== spec.namespace || current.ownerId !== spec.ownerId ||
        current.title !== spec.title || current.contentHash !== digest(spec.content) || current.status !== 'approved') throw changed()
    const prepared = await prepare(current, spec, db)
    if (!canPublish(prepared.spec)) throw changed()
    return publish(prepared.spec, prepared.spec.category, prepared.identities, revision, context)
  })
}

module.exports = { createReviewedPublication }
