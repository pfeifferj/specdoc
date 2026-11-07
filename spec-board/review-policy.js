'use strict'

const { WindowLimiter } = require('./request-controls')

function createReviewPolicyReader ({ namespaces, read, refresh, now = Date.now, intervalMs = 30000 }) {
  const allowed = new Set(namespaces)
  const budget = new WindowLimiter({ capacity: Math.max(1, allowed.size), windowMs: intervalMs, now })
  const pending = new Map()
  return async (source, eligible = () => true) => {
    if (!allowed.has(source.namespace)) return null
    const cached = await read(source)
    if (cached && !eligible(cached)) return cached
    if (pending.has(source.namespace)) return pending.get(source.namespace)
    if (!budget.take(source.namespace, 1)) return cached
    const loading = Promise.resolve().then(() => refresh(source)).finally(() => pending.delete(source.namespace))
    pending.set(source.namespace, loading)
    return loading
  }
}

module.exports = { createReviewPolicyReader }
