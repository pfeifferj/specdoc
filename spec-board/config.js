function numberConfig (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {}, env = process.env) {
  const raw = env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)) ||
      (typeof raw === 'string' && raw !== '' && !raw.trim())) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`)
  }
  return value
}

function numericConfig (env = process.env) {
  const read = (name, fallback, options) => numberConfig(name, fallback, options, env)
  return {
    port: read('PORT', 8080, { min: 1, max: 65535 }),
    pollSeconds: read('POLL_SECONDS', 60, { min: 1, max: 86400 }),
    fetchTimeoutMs: read('FETCH_TIMEOUT_MS', 15000, { min: 1, max: 300000 }),
    staleDays: read('STALE_DAYS', 14, { min: 0, max: 365000, integer: false }),
    reviewIdleMinutes: read('REVIEW_IDLE_MINUTES', 10, { min: 0, max: 10080, integer: false }),
    overlapMaxBytes: read('OVERLAP_MAX_BYTES', 200000, { min: 1, max: 10000000 }),
    emailDebounceMinutes: read('EMAIL_DEBOUNCE_MINUTES', 30, { min: 0, max: 10080, integer: false }),
    smtpPort: read('SMTP_PORT', 587, { min: 1, max: 65535 }),
    trustedProxies: read('TRUSTED_PROXIES', 1, { min: 0, max: 32 })
  }
}

module.exports = { numberConfig, numericConfig }
