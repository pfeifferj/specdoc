const crypto = require('crypto')

class WindowLimiter {
  constructor ({ capacity = 10000, windowMs = 10000, now = Date.now } = {}) {
    this.capacity = capacity
    this.windowMs = windowMs
    this.now = now
    this.buckets = new Map()
  }

  take (key, limit, cost = 1) {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.until <= now) {
      if (!bucket && this.buckets.size >= this.capacity) {
        for (const [id, value] of this.buckets) if (value.until <= now) this.buckets.delete(id)
        if (this.buckets.size >= this.capacity) return false
      }
      bucket = { until: now + this.windowMs, count: 0 }
      this.buckets.set(key, bucket)
    }
    if (bucket.count + cost > limit) return false
    bucket.count += cost
    return true
  }
}

class BoundedCache {
  constructor (capacity = 50, ttl = 60000, now = Date.now) {
    this.entries = new Map()
    this.capacity = capacity
    this.ttl = ttl
    this.now = now
  }

  get (key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    if (entry.until <= this.now()) return undefined
    this.entries.set(key, entry)
    return entry.value
  }

  set (key, value) {
    this.entries.delete(key)
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value)
    this.entries.set(key, { value, until: this.now() + this.ttl })
    return value
  }

  delete (key) { this.entries.delete(key) }
}

function concurrencyLimit (limit) {
  let active = 0
  return async fn => {
    if (active >= limit) throw Object.assign(new Error('Work capacity exhausted'), { status: 503 })
    active++
    try { return await fn() } finally { active-- }
  }
}

async function boundedJson (response, maxBytes = 512 * 1024) {
  const length = Number(response.headers?.get('content-length'))
  if (length > maxBytes) { await response.body?.cancel(); throw new Error('Response exceeds byte limit') }
  if (!response.body) throw new Error('Empty response')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error('Response exceeds byte limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function monitoringAccess (req, token = process.env.MONITORING_TOKEN) {
  if (!token || token.length < 32) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(req.headers.authorization || '')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

const webhookText = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›').slice(0, 2000)

module.exports = { WindowLimiter, BoundedCache, concurrencyLimit, boundedJson, monitoringAccess, webhookText }
