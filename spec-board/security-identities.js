'use strict'

const subject = value => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof text === 'string' && /^[1-9]\d{0,19}$/.test(text) ? text : null
}

function principals (value) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value]
  const result = []
  const seen = new Set()
  for (const entry of list) {
    const object = entry && typeof entry === 'object' && !Array.isArray(entry)
    const raw = object ? entry.id : typeof entry === 'string' ? entry.trim().replace(/^github:/, '') : entry
    const id = subject(raw)
    if (!id || seen.has(id)) return null
    const login = object && typeof entry.login === 'string' && /^[\w-]{1,39}$/.test(entry.login) ? entry.login : `github:${id}`
    seen.add(id)
    result.push({ subject: id, login })
  }
  return result
}

function authorized (who, roster) {
  const id = who && who.provider === 'github' && subject(who.subject)
  const entries = principals(roster)
  return !!(id && entries && entries.some(entry => entry.subject === id))
}

function governance (roles) {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return null
  const approvers = principals(roles.approvers)
  const authors = principals(roles.authors)
  const required = roles['approvals-required'] === undefined ? 1 : roles['approvals-required']
  if (!approvers || !authors || !Number.isSafeInteger(required) || required < 0 || required > approvers.length) return null
  return { approvers, authors, required }
}

module.exports = { subject, principals, authorized, governance }
