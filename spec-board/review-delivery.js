const crypto = require('node:crypto')
const { assertNoCredentials } = require('./sensitive-content')

const MAX_ATTEMPTS = 8
const RETENTION_MS = 86400000
const MAX_DELIVERY_BYTES = 4 * 1024 * 1024
const terminal = error => [400, 403, 404, 410, 412, 422].includes(error.status) ||
  ['review-source-changed', 'review-delivery-too-large', 'SENSITIVE_CONTENT'].includes(error.code)
const reason = error => /^[A-Za-z0-9_-]{1,80}$/.test(error.code || '') ? error.code : `delivery-${error.status || 'unavailable'}`

function checkPayload (delivery) {
  const payload = JSON.stringify(delivery)
  if (Buffer.byteLength(payload) > MAX_DELIVERY_BYTES) throw Object.assign(new Error('Review delivery exceeds its storage limit'), { code: 'review-delivery-too-large' })
  assertNoCredentials(payload)
}

function prepareDelivery ({ namespace, noteIds, mutation, inline = null, findings, notification = null }, now = Date.now()) {
  const delivery = { id: crypto.randomUUID(), state: 'pending', namespace, noteIds: [...new Set(noteIds)],
    createdAt: now, expiresAt: now + RETENTION_MS, retryAt: now, attempts: 0, rejected: 0,
    mutation, inline, findings, notification }
  checkPayload(delivery)
  return delivery
}

async function deliverReview (delivery, { save, recordFinding, mutate, rebase, assertActive, now = Date.now, retryMs = 60000 }) {
  if (!delivery || delivery.state !== 'pending') return { mutated: false }
  const persist = async value => {
    assertActive()
    if (!await save(value)) throw Object.assign(new Error('Review delivery was replaced'), { code: 'review-delivery-replaced' })
  }
  const failed = cause => ({ id: delivery.id, state: 'failed', reason: cause, rejected: delivery.rejected })
  if (delivery.expiresAt <= now()) { await persist(failed('expired')); return { mutated: false } }
  if (delivery.retryAt > now()) return { mutated: false }
  // Recheck ownership before any external effect, including after process restart.
  await persist(delivery)
  if (delivery.findings.length) {
    const pending = []
    for (const finding of delivery.findings) {
      assertActive()
      try { await recordFinding(finding) } catch (error) {
        delivery.reason = reason(error)
        if (terminal(error)) delivery.rejected++
        else pending.push(finding)
      }
    }
    delivery.findings = pending
    if (pending.length && ++delivery.attempts < MAX_ATTEMPTS) {
      delivery.retryAt = now() + Math.min(2 ** delivery.attempts, 60) * retryMs
      await persist(delivery)
      return { mutated: false }
    }
    delivery.rejected += pending.length
    delivery.findings = []
    delivery.attempts = 0
    delivery.retryAt = now()
    await persist(delivery)
  }
  let mutated = false
  if (delivery.mutation) {
    assertActive()
    try { await mutate(delivery.mutation); mutated = true } catch (error) {
      if (error.status === 412 && rebase) {
        try {
          const mutation = await rebase(delivery.mutation)
          checkPayload({ ...delivery, mutation })
          delivery.mutation = mutation
          if (!mutation) {
            await persist(delivery.rejected ? failed(delivery.reason || 'review-delivery-incomplete') : null)
            return { mutated: false }
          }
          error = Object.assign(new Error('Review operation rebased'), { code: 'review-rebased' })
        } catch (rebasingError) { error = rebasingError }
      }
      const waiting = error.status === 409
      if (terminal(error) || (!waiting && ++delivery.attempts >= MAX_ATTEMPTS)) {
        delivery.rejected++
        await persist(failed(reason(error)))
      } else {
        delivery.reason = reason(error)
        if (waiting) delivery.waits = Math.min((delivery.waits || 0) + 1, 6)
        delivery.retryAt = now() + Math.min(2 ** (waiting ? delivery.waits : delivery.attempts), 60) * retryMs
        await persist(delivery)
      }
      return { mutated: false }
    }
  }
  await persist(delivery.rejected ? failed(delivery.reason || 'review-delivery-incomplete') : null)
  return { mutated }
}

module.exports = { prepareDelivery, deliverReview, MAX_ATTEMPTS, RETENTION_MS, MAX_DELIVERY_BYTES }
