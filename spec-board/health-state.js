const reserved = new Set(['ok', 'lastSuccessAt', 'lastFailureAt', 'consecutiveFailures', 'error'])

function createHealthState ({ now = Date.now } = {}) {
  const entries = new Map()
  const get = name => ({ ok: null, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, error: null, ...entries.get(name) })
  function observe (name, details = {}) {
    const entry = { ...get(name), ...Object.fromEntries(Object.entries(details).filter(([key]) => !reserved.has(key))) }
    entries.set(name, entry)
    return { ...entry }
  }
  function success (name, details = {}) {
    const entry = { ...observe(name, details), ok: true, lastSuccessAt: now(), consecutiveFailures: 0, error: null }
    entries.set(name, entry)
    return { ...entry }
  }
  function failure (name, error, details = {}) {
    const code = error && (error.code || error.name) || error
    const entry = { ...observe(name, details), ok: false, lastFailureAt: now(),
      consecutiveFailures: get(name).consecutiveFailures + 1,
      error: typeof code === 'string' && /^[\w.:-]{1,80}$/.test(code) ? code : 'Error' }
    entries.set(name, entry)
    return { ...entry }
  }
  return { get, observe, success, failure, status: () => Object.fromEntries([...entries].map(([name]) => [name, get(name)])) }
}

module.exports = { createHealthState }
