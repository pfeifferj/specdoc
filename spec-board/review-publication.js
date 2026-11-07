function createReviewedPublication ({ store, authorize, publish }) {
  return (spec, previous, revision, context) => store.withPublicationLock(spec.id, async () => {
    const authorization = await authorize(spec, previous, revision)
    const opened = await publish(spec, previous, revision, context, authorization)
    return { opened, authorization }
  })
}

module.exports = { createReviewedPublication }
