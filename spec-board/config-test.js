const assert = require('assert/strict')
const { numberConfig, numericConfig } = require('./config')
const defaults = numericConfig({})
assert.equal(defaults.pollSeconds, 60)
assert.equal(defaults.smtpPort, 587)
assert.equal(numericConfig({ TRUSTED_PROXIES: '0', EMAIL_DEBOUNCE_MINUTES: '0.25' }).trustedProxies, 0)
assert.equal(numericConfig({ EMAIL_DEBOUNCE_MINUTES: '0.25' }).emailDebounceMinutes, 0.25)
for (const [key, value] of [['POLL_SECONDS', '60s'], ['POLL_SECONDS', '0'], ['POLL_SECONDS', 'Infinity'],
  ['FETCH_TIMEOUT_MS', '-1'], ['FETCH_TIMEOUT_MS', '0'], ['SMTP_PORT', '65536'], ['SMTP_PORT', '25.5'],
  ['TRUSTED_PROXIES', '1.5'], ['TRUSTED_PROXIES', '-1'], ['EMAIL_DEBOUNCE_MINUTES', 'NaN'],
  ['EMAIL_DEBOUNCE_MINUTES', '-1'], ['REVIEW_IDLE_MINUTES', ' '], ['OVERLAP_MAX_BYTES', '0']]) {
  assert.throws(() => numericConfig({ [key]: value }), new RegExp(key))
}
assert.equal(numberConfig('OPTION', 10, { min: 1, max: 10 }, {}), 10)
console.log('configuration tests passed')
